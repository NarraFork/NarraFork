import { describe, expect, test } from "bun:test";
import type { OccupancyTask } from "./background-occupancy-index";
import {
	BackgroundOccupancyInitializer,
	withBackgroundOccupancyInitialization,
} from "./background-occupancy-startup";
import {
	type BackgroundOccupancySource,
	BackgroundOccupancyStore,
} from "./background-occupancy-store";

class RetryClock {
	private nextId = 0;
	pending = new Map<number, { retry: () => void; delayMs: number }>();
	delays: number[] = [];
	schedule = (retry: () => void, delayMs: number): (() => void) => {
		const id = ++this.nextId;
		this.delays.push(delayMs);
		this.pending.set(id, { retry, delayMs });
		return () => this.pending.delete(id);
	};
	fire(): void {
		const next = this.pending.entries().next().value;
		if (!next) throw new Error("No retry was scheduled");
		this.pending.delete(next[0]);
		next[1].retry();
	}
}

const ignoreFailure = () => {};

test("stop drains an existing initialization and records its failure without retry", async () => {
	let reject = (_error: Error) => {};
	const pending = new Promise<void>((_resolve, fail) => {
		reject = fail;
	});
	const clock = new RetryClock();
	const initializer = new BackgroundOccupancyInitializer(
		() => pending,
		clock.schedule,
		ignoreFailure,
	);
	const start = initializer.start();
	await Promise.resolve();
	initializer.stop();
	const controller = new AbortController();
	const drain = initializer.drainForShutdown(controller.signal);
	controller.abort(new Error("deadline"));
	await expect(drain).rejects.toThrow("deadline");
	expect(initializer.getShutdownState().pending).toBe(1);
	const error = new Error("initialization failed");
	reject(error);
	await start;
	await initializer.drainForShutdown(new AbortController().signal);
	expect(initializer.getShutdownState()).toEqual({
		pending: 0,
		failureCount: 1,
		firstError: error,
	});
	expect(clock.pending.size).toBe(0);
});

test("stop before the queued initial scan does not launch it", async () => {
	let calls = 0;
	const initializer = new BackgroundOccupancyInitializer(async () => {
		calls++;
	});
	const start = initializer.start();
	initializer.stop();
	await start;
	expect(calls).toBe(0);
});

describe("explicit background occupancy initialization recovery", () => {
	test("a transient cold read failure recovers without any request initiating a scan", async () => {
		const clock = new RetryClock();
		let narratorScans = 0;
		let fail = true;
		const tasks = new Map<string, OccupancyTask>();
		const source: BackgroundOccupancySource = {
			async scanNarrators() {
				narratorScans++;
				if (fail) throw new Error("transient SQL lock");
				return [];
			},
			async scanTasks() {
				return [...tasks.values()];
			},
			async getNarrators() {
				return [];
			},
			async getTasks(ids) {
				return [...tasks.values()].filter((task) => ids.includes(task.id));
			},
			async getProjections() {
				return [];
			},
		};
		const store = new BackgroundOccupancyStore(source);
		const initializer = new BackgroundOccupancyInitializer(
			() => store.start(),
			clock.schedule,
			ignoreFailure,
		);
		try {
			expect(await initializer.start()).toBe(false);
			expect(store.isReady).toBe(false);
			tasks.set("work", {
				id: "work",
				parentNarratorId: "parent",
				type: "bash",
				status: "running",
				backgroundKind: "task",
				subagentNarratorId: null,
			});
			store.refreshTask("work");
			await expect(store.flush()).rejects.toThrow("not initialized");
			expect(narratorScans).toBe(1);
			fail = false;
			clock.fire();
			expect(await initializer.start()).toBe(true);
			await store.flush();
			expect(store.isReady).toBe(true);
			expect(store.snapshot(["parent"]).counts.get("parent")?.activeWorkCount).toBe(1);
			expect(narratorScans).toBe(2);
			expect(clock.pending.size).toBe(0);
		} finally {
			initializer.stop();
			store.resetForTests();
		}
	});

	test("retries have capped exponential backoff and repeated starts cannot duplicate or bypass it", async () => {
		const clock = new RetryClock();
		let attempts = 0;
		let fail = true;
		const initializer = new BackgroundOccupancyInitializer(
			async () => {
				attempts++;
				if (fail) throw new Error("database unavailable");
			},
			clock.schedule,
			ignoreFailure,
		);
		try {
			expect(await initializer.start()).toBe(false);
			for (let i = 0; i < 6; i++) {
				const before = attempts;
				expect(await initializer.start()).toBe(false);
				expect(attempts).toBe(before);
				expect(clock.pending.size).toBe(1);
				clock.fire();
				expect(await initializer.start()).toBe(false);
			}
			expect(clock.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
			fail = false;
			clock.fire();
			expect(await initializer.start()).toBe(true);
			expect(attempts).toBe(8);
			expect(clock.pending.size).toBe(0);
			expect(await initializer.start()).toBe(true);
			expect(attempts).toBe(8);
		} finally {
			initializer.stop();
		}
	});

	test("concurrent callers share one in-flight attempt", async () => {
		let resolve = () => {};
		const blocked = new Promise<void>((done) => {
			resolve = done;
		});
		let attempts = 0;
		const initializer = new BackgroundOccupancyInitializer(async () => {
			attempts++;
			await blocked;
		});
		try {
			const first = initializer.start();
			expect(initializer.start()).toBe(first);
			await Promise.resolve();
			expect(attempts).toBe(1);
			resolve();
			expect(await first).toBe(true);
		} finally {
			resolve();
			initializer.stop();
		}
	});

	test("shutdown cancels pending retries and prevents new attempts", async () => {
		const clock = new RetryClock();
		let attempts = 0;
		const initializer = new BackgroundOccupancyInitializer(
			async () => {
				attempts++;
				throw new Error("offline");
			},
			clock.schedule,
			ignoreFailure,
		);
		expect(await initializer.start()).toBe(false);
		expect(clock.pending.size).toBe(1);
		initializer.stop();
		expect(clock.pending.size).toBe(0);
		expect(await initializer.start()).toBe(false);
		expect(attempts).toBe(1);
	});

	test("shutdown during an in-flight failure does not schedule a late retry", async () => {
		const clock = new RetryClock();
		let reject = (_error: Error) => {};
		const blocked = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		const initializer = new BackgroundOccupancyInitializer(
			() => blocked,
			clock.schedule,
			ignoreFailure,
		);
		const attempt = initializer.start();
		await Promise.resolve();
		initializer.stop();
		reject(new Error("late failure"));
		expect(await attempt).toBe(false);
		expect(clock.pending.size).toBe(0);
	});

	test("initializes after successful recovery and before its continuation", async () => {
		const steps: string[] = [];
		const initializer = new BackgroundOccupancyInitializer(async () => {
			steps.push("initialize");
		});
		try {
			const result = await withBackgroundOccupancyInitialization(async () => {
				steps.push("recover");
				return "recovery handles";
			}, initializer).then((value) => {
				steps.push("continue");
				return value;
			});
			expect(result).toBe("recovery handles");
			expect(steps).toEqual(["recover", "initialize", "continue"]);
		} finally {
			initializer.stop();
		}
	});

	test("an early recovery failure still initializes and preserves the original recovery error", async () => {
		let attempts = 0;
		const failure = new Error("planned-update recovery failed");
		const initializer = new BackgroundOccupancyInitializer(async () => {
			attempts++;
		});
		try {
			await expect(
				withBackgroundOccupancyInitialization(async () => {
					throw failure;
				}, initializer),
			).rejects.toBe(failure);
			expect(attempts).toBe(1);
		} finally {
			initializer.stop();
		}
	});

	test("recovery and initialization failures still schedule an independent retry", async () => {
		const clock = new RetryClock();
		const failure = new Error("recovery failed");
		let attempts = 0;
		const initializer = new BackgroundOccupancyInitializer(
			async () => {
				if (++attempts === 1) throw new Error("transient initialization error");
			},
			clock.schedule,
			ignoreFailure,
		);
		try {
			await expect(
				withBackgroundOccupancyInitialization(async () => {
					throw failure;
				}, initializer),
			).rejects.toBe(failure);
			expect(clock.pending.size).toBe(1);
			clock.fire();
			expect(await initializer.start()).toBe(true);
		} finally {
			initializer.stop();
		}
	});

	test("unsupported backends do not initialize the SQLite occupancy store", async () => {
		expect(await withBackgroundOccupancyInitialization(async () => "postgres", undefined)).toBe(
			"postgres",
		);
	});

	test("diagnostic hook failures cannot discard a scheduled recovery", async () => {
		const clock = new RetryClock();
		let attempts = 0;
		const initializer = new BackgroundOccupancyInitializer(
			async () => {
				if (++attempts === 1) throw new Error("temporary");
			},
			clock.schedule,
			() => {
				throw new Error("logger failed");
			},
		);
		try {
			expect(await initializer.start()).toBe(false);
			expect(clock.pending.size).toBe(1);
			clock.fire();
			expect(await initializer.start()).toBe(true);
		} finally {
			initializer.stop();
		}
	});
});
