import { afterEach, describe, expect, test } from "bun:test";
import {
	createNarratorSyncScheduler,
	type NarratorSyncScheduler,
} from "../project-db-sync-scheduler";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let scheduler: NarratorSyncScheduler | null = null;
afterEach(() => {
	scheduler?.dispose();
	scheduler = null;
});

describe("createNarratorSyncScheduler", () => {
	test("events inside the debounce window coalesce into one run", async () => {
		const runs: string[] = [];
		scheduler = createNarratorSyncScheduler({
			debounceMs: 20,
			minIntervalMs: 0,
			run: async (key) => {
				runs.push(key);
			},
		});
		for (let i = 0; i < 10; i++) scheduler.schedule("a");
		await sleep(60);
		expect(runs).toEqual(["a"]);
	});

	test("a steady stream of events does not postpone the run forever", async () => {
		// A trailing debounce resets on every event; this one must fire within debounceMs of the
		// FIRST event even though events keep arriving.
		const runs: number[] = [];
		const started = Date.now();
		scheduler = createNarratorSyncScheduler({
			debounceMs: 30,
			minIntervalMs: 0,
			run: async () => {
				runs.push(Date.now() - started);
			},
		});
		for (let i = 0; i < 8; i++) {
			scheduler.schedule("a");
			await sleep(10);
		}
		expect(runs.length).toBeGreaterThanOrEqual(1);
		expect(runs[0]).toBeLessThan(70);
	});

	test("at most one run per key is in flight, and events during it get exactly one follow-up", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let runs = 0;
		const gate: { release: (() => void) | null } = { release: null };
		scheduler = createNarratorSyncScheduler({
			debounceMs: 5,
			minIntervalMs: 0,
			run: async () => {
				runs++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				if (runs === 1) {
					await new Promise<void>((resolve) => {
						gate.release = resolve;
					});
				}
				inFlight--;
			},
		});
		scheduler.schedule("a");
		await sleep(20);
		expect(runs).toBe(1);
		// Events while the first run is blocked.
		for (let i = 0; i < 5; i++) scheduler.schedule("a");
		await sleep(20);
		expect(runs).toBe(1);
		gate.release?.();
		await sleep(40);
		expect(runs).toBe(2);
		expect(maxInFlight).toBe(1);
	});

	test("consecutive runs of one key respect the minimum interval", async () => {
		const starts: number[] = [];
		scheduler = createNarratorSyncScheduler({
			debounceMs: 5,
			minIntervalMs: 80,
			run: async () => {
				starts.push(Date.now());
			},
		});
		scheduler.schedule("a");
		await sleep(20);
		scheduler.schedule("a");
		await sleep(40);
		expect(starts).toHaveLength(1);
		await sleep(60);
		expect(starts).toHaveLength(2);
		expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(75);
	});

	test("keys are independent", async () => {
		const runs: string[] = [];
		scheduler = createNarratorSyncScheduler({
			debounceMs: 5,
			minIntervalMs: 1_000,
			run: async (key) => {
				runs.push(key);
			},
		});
		scheduler.schedule("a");
		scheduler.schedule("b");
		await sleep(30);
		expect(runs.sort()).toEqual(["a", "b"]);
	});

	test("a failed run is reported and does not wedge the key", async () => {
		const errors: unknown[] = [];
		let runs = 0;
		scheduler = createNarratorSyncScheduler({
			debounceMs: 5,
			minIntervalMs: 0,
			run: async () => {
				runs++;
				if (runs === 1) throw new Error("boom");
			},
			onError: (_key, error) => errors.push(error),
		});
		scheduler.schedule("a");
		await sleep(20);
		scheduler.schedule("a");
		await sleep(20);
		expect(runs).toBe(2);
		expect(errors).toHaveLength(1);
	});

	test("dispose cancels pending runs", async () => {
		let runs = 0;
		scheduler = createNarratorSyncScheduler({
			debounceMs: 10,
			minIntervalMs: 0,
			run: async () => {
				runs++;
			},
		});
		scheduler.schedule("a");
		scheduler.dispose();
		scheduler.schedule("a");
		await sleep(30);
		expect(runs).toBe(0);
	});
});
