import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createDatabaseReaderReadiness,
	type DatabaseReaderResult,
	databaseReadersAvailable,
} from "../db-reader-readiness";
import { createDatabaseReaderStartup } from "../db-reader-startup";
import { createStartupReadinessGate } from "../startup-readiness";

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Database startup did not settle");
		await Bun.sleep(1);
	}
}

describe("database reader startup recovery", () => {
	test("shutdown drains an in-flight initializer before relinquishing ownership", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status: "ready" }, wait: async () => ({ ok: true }) },
			initialize: async () => {
				entered.resolve();
				await release.promise;
			},
			onUnavailable() {},
			onError(error) {
				throw error;
			},
		});
		try {
			expect(startup.pending).toBe(false);
			await startup.drain();
			const first = startup.start();
			await entered.promise;
			startup.stop();
			let drained = false;
			const draining = startup.drain().then(() => {
				drained = true;
			});
			await Bun.sleep(5);
			expect(startup.pending).toBe(true);
			expect(drained).toBe(false);
			release.resolve();
			await Promise.all([first, draining]);
			expect(startup.pending).toBe(false);
			expect(drained).toBe(true);
		} finally {
			startup.stop();
			release.resolve();
		}
	});

	test("a failed first probe stays closed, then initializes once and settles readiness", async () => {
		let probes = 0;
		const probe = mock(async () => {
			if (++probes === 1) throw new Error("injected Worker startup failure");
		});
		const readiness = createDatabaseReaderReadiness({
			backend: "sqlite",
			probe,
			retryIntervalMs: 0,
		});
		const gate = createStartupReadinessGate();
		const initialize = mock(async () => {
			gate.markReady();
			gate.settle({ ok: true });
		});
		const onUnavailable = mock(() => {});
		const onError = mock(() => {});
		const startup = createDatabaseReaderStartup({
			readiness,
			initialize,
			onUnavailable,
			onError,
			retryIntervalMs: 5,
		});
		try {
			await startup.start();
			expect(databaseReadersAvailable(readiness.state)).toBe(false);
			expect(gate.state).toEqual({ status: "recovering" });
			expect(initialize).not.toHaveBeenCalled();
			expect(onUnavailable).toHaveBeenCalledWith({ ok: false, code: "DB_READERS_UNAVAILABLE" });
			await until(() => gate.state.status === "ready");
			expect(await gate.barrier).toEqual({ ok: true });
			expect(databaseReadersAvailable(readiness.state)).toBe(true);
			await Promise.all([startup.start(), startup.start(), readiness.wait()]);
			expect(initialize).toHaveBeenCalledTimes(1);
			expect(probe).toHaveBeenCalledTimes(2);
			expect(onError).not.toHaveBeenCalled();
		} finally {
			startup.stop();
		}
	});

	test.each([
		"ready",
		"not-required",
	] as const)("initial %s admission and concurrent starts share one initialization", async (status) => {
		const work = Promise.withResolvers<void>();
		const initialize = mock(async () => work.promise);
		const wait = mock(async () => ({ ok: true }) as const);
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status }, wait },
			initialize,
			onUnavailable: () => {},
			onError: () => {},
		});
		try {
			const first = startup.start();
			expect(startup.start()).toBe(first);
			await until(() => initialize.mock.calls.length === 1);
			expect(startup.start()).toBe(first);
			work.resolve();
			await first;
			await startup.start();
			expect(initialize).toHaveBeenCalledTimes(1);
			expect(wait).toHaveBeenCalledTimes(1);
		} finally {
			startup.stop();
		}
	});

	test("shutdown cancels a queued retry before it can probe or initialize", async () => {
		const wait = mock(
			async (): Promise<DatabaseReaderResult> => ({ ok: false, code: "DB_READERS_UNAVAILABLE" }),
		);
		const initialize = mock(async () => {});
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status: "waiting" }, wait },
			initialize,
			onUnavailable: () => {},
			onError: () => {},
			retryIntervalMs: 5,
		});
		await startup.start();
		startup.stop();
		await Bun.sleep(20);
		await startup.start();
		expect(wait).toHaveBeenCalledTimes(1);
		expect(initialize).not.toHaveBeenCalled();
	});

	test("shutdown during a recovery probe ignores its late success", async () => {
		const recovered = Promise.withResolvers<DatabaseReaderResult>();
		let attempts = 0;
		const wait = mock(async (): Promise<DatabaseReaderResult> => {
			if (++attempts === 1) return { ok: false, code: "DB_READERS_TIMEOUT" };
			return recovered.promise;
		});
		const initialize = mock(async () => {});
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status: "waiting" }, wait },
			initialize,
			onUnavailable: () => {},
			onError: () => {},
			retryIntervalMs: 5,
		});
		await startup.start();
		await until(() => attempts === 2);
		startup.stop();
		recovered.resolve({ ok: true });
		await Bun.sleep(20);
		expect(wait).toHaveBeenCalledTimes(2);
		expect(initialize).not.toHaveBeenCalled();
	});

	test("shutdown before start does not probe", async () => {
		const wait = mock(async () => ({ ok: true }) as const);
		const initialize = mock(async () => {});
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status: "ready" }, wait },
			initialize,
			onUnavailable: () => {},
			onError: () => {},
		});
		startup.stop();
		await startup.start();
		expect(wait).not.toHaveBeenCalled();
		expect(initialize).not.toHaveBeenCalled();
	});

	test("unavailable readers keep retries sequential and report once without initialization", async () => {
		const pending = Promise.withResolvers<DatabaseReaderResult>();
		const wait = mock(async () => pending.promise);
		const initialize = mock(async () => {});
		const onUnavailable = mock(() => {});
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status: "waiting" }, wait },
			initialize,
			onUnavailable,
			onError: () => {},
			retryIntervalMs: 5,
		});
		try {
			const first = startup.start();
			await Bun.sleep(20);
			expect(wait).toHaveBeenCalledTimes(1);
			pending.resolve({ ok: false, code: "DB_READERS_UNAVAILABLE" });
			await first;
			await until(() => wait.mock.calls.length >= 3);
			expect(onUnavailable).toHaveBeenCalledTimes(1);
			expect(initialize).not.toHaveBeenCalled();
		} finally {
			startup.stop();
		}
	});

	test("an initialization error is reported without repeating partially-started services", async () => {
		const error = new Error("injected initialization failure");
		const initialize = mock(async () => {
			throw error;
		});
		const onError = mock(() => {});
		const startup = createDatabaseReaderStartup({
			readiness: { state: { status: "ready" }, wait: async () => ({ ok: true }) },
			initialize,
			onUnavailable: () => {},
			onError,
			retryIntervalMs: 5,
		});
		try {
			await startup.start();
			await Bun.sleep(20);
			await startup.start();
			expect(initialize).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(error);
			expect(startup.pending).toBe(false);
			expect(await startup.drain().catch((failure: unknown) => failure)).toBe(error);
		} finally {
			startup.stop();
		}
	});
});

test("main runs every gated startup service through the recovery initializer", () => {
	const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
	const start = source.indexOf("async function initializeDatabaseStartup(): Promise<void> {");
	const end = source.indexOf("\nconst databaseStartup =", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const initializer = source.slice(start, end);
	for (const call of [
		"scheduleBackgroundIntegrityCheck(startupShutdownState)",
		"startHeartbeat()",
		"initDeviceConnectionService()",
		"initDeviceTransferService()",
		"withBackgroundOccupancyInitialization(",
		"finishRecoveryDiscovery()",
		"startupReadiness.settle({ ok: true })",
		"cleanupStaleShares()",
		"packActivationService.cleanupStalePacks()",
		"startPrefixSnapshotMaintenance()",
		"startSessionCleanupTimer()",
		"startScheduledTaskScheduler()",
		"gateway.start()",
		"startLiveReplay()",
		"ensureAllRecentTabsMigrated()",
		"initNotificationFanout()",
		"startNotificationCenterMaintenance()",
		'startTeamDatabaseMaintenance("status"',
	])
		expect(initializer).toContain(call);
	expect(source).not.toContain("readerStartupAdmission");
	expect(source.slice(end)).toContain("initialize: initializeDatabaseStartup");
	expect(source.slice(end)).toContain("await databaseStartup.start()");
});
