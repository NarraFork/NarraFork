import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	capturePlannedUpdateRecoverySnapshot,
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
} from "../../services/update-coordinator";
import {
	canOperatorShutdown,
	registerOperatorShutdownHandler,
	scheduleOperatorShutdown,
	shutdownDesktopServer,
} from "../server-restart";
import { preservesRecoveryOnShutdown } from "../shutdown-activity";
import { createShutdownTask } from "../shutdown-task";
import { createSystemLifecycle } from "../system-lifecycle";

afterEach(() => {
	registerOperatorShutdownHandler(null);
	resetUpdateCoordinationForTests();
});

describe("operator shutdown admission", () => {
	test("a queued legacy shutdown owns its grace window and blocks system preparation", async () => {
		const handler = mock(async ({ reason }: { reason: string }) => ({
			success: true,
			reason,
			pid: process.pid,
			durationMs: 0,
		}));
		registerOperatorShutdownHandler(handler);
		expect(canOperatorShutdown()).toBe(true);
		expect(scheduleOperatorShutdown({ reason: "operator_requested" })).toBe(true);
		expect(canOperatorShutdown()).toBe(false);
		expect(scheduleOperatorShutdown({ reason: "system_prepared_shutdown" })).toBe(false);
		const lifecycle = createSystemLifecycle({
			coordination: getUpdateCoordinationStatus,
			canShutdown: canOperatorShutdown,
			schedule: () => scheduleUpdate(undefined, "system_shutdown"),
			drain: async () => capturePlannedUpdateRecoverySnapshot(),
			persist: () => {
				throw new Error("must not checkpoint");
			},
			assertNotCancelled: () => {},
			markClosing: () => {},
			shutdown: () => scheduleOperatorShutdown({ reason: "system_prepared_shutdown" }),
			cancel: () => {},
			cleanup: async () => {},
			isCancellation: () => false,
		});
		expect(lifecycle.prepare().success).toBe(false);
		expect(lifecycle.shutdown().success).toBe(false);
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
		await Bun.sleep(350);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ reason: "operator_requested" });
	});

	test("only checkpoint-backed shutdown reasons preserve processes and browser sessions", () => {
		expect(preservesRecoveryOnShutdown("system_prepared_shutdown")).toBe(true);
		expect(preservesRecoveryOnShutdown("replacement_started")).toBe(true);
		expect(preservesRecoveryOnShutdown("operator_requested")).toBe(false);
		expect(preservesRecoveryOnShutdown("signal")).toBe(false);
	});
});

describe("desktop shutdown coordination", () => {
	test("desktop quit waits for both the administrator grace window and in-flight teardown", async () => {
		const cleanup = Promise.withResolvers<void>();
		const handler = mock(async ({ reason }: { reason: string }) => {
			await cleanup.promise;
			return { success: true, reason, pid: process.pid, durationMs: 0 };
		});
		registerOperatorShutdownHandler(handler);
		expect(scheduleOperatorShutdown({ reason: "operator_requested" })).toBe(true);
		let completed = false;
		const first = shutdownDesktopServer().then(() => {
			completed = true;
		});
		const second = shutdownDesktopServer();
		expect(handler).toHaveBeenCalledTimes(0);
		await Bun.sleep(350);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ reason: "operator_requested" });
		expect(completed).toBe(false);
		const third = shutdownDesktopServer();
		cleanup.resolve();
		await Promise.all([first, second, third]);
		expect(completed).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("desktop shutdown owns admission and shares a single teardown", async () => {
		const handler = mock(async ({ reason }: { reason: string }) => ({
			success: true,
			reason,
			pid: process.pid,
			durationMs: 0,
		}));
		registerOperatorShutdownHandler(handler);
		const first = shutdownDesktopServer();
		expect(canOperatorShutdown()).toBe(false);
		expect(scheduleOperatorShutdown({ reason: "operator_requested" })).toBe(false);
		await Promise.all([first, shutdownDesktopServer()]);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ reason: "desktop_quit" });
	});

	test("unsuccessful cleanup rejects and allows retry rather than exiting", async () => {
		const handler = mock(async ({ reason }: { reason: string }) => ({
			success: false,
			reason,
			pid: process.pid,
			durationMs: 0,
		}));
		registerOperatorShutdownHandler(handler);
		await expect(shutdownDesktopServer()).rejects.toThrow("desktop_quit");
		expect(canOperatorShutdown()).toBe(true);
		await expect(shutdownDesktopServer()).rejects.toThrow("desktop_quit");
		expect(handler).toHaveBeenCalledTimes(2);
	});

	test("scheduled rejection reaches desktop waiters and releases admission", async () => {
		registerOperatorShutdownHandler(async () => {
			throw new Error("cleanup failed");
		});
		expect(scheduleOperatorShutdown({ reason: "operator_requested" })).toBe(true);
		await expect(shutdownDesktopServer()).rejects.toThrow("cleanup failed");
		expect(canOperatorShutdown()).toBe(true);
	});

	test("failed boot without a registered server can still close the desktop", async () => {
		registerOperatorShutdownHandler(null);
		await shutdownDesktopServer();
		expect(canOperatorShutdown()).toBe(false);
	});
});

test("desktop retry reaches the server cleanup task after a rejected first attempt", async () => {
	let attempts = 0;
	const cleanup = createShutdownTask(async ({ reason }: { reason: string }) => {
		attempts++;
		if (attempts === 1) throw new Error("partial teardown failure");
		return { success: true, reason, pid: process.pid, durationMs: 0 };
	});
	registerOperatorShutdownHandler(cleanup);
	await expect(shutdownDesktopServer()).rejects.toThrow("partial teardown failure");
	await Promise.all([shutdownDesktopServer(), shutdownDesktopServer()]);
	expect(attempts).toBe(2);
	await shutdownDesktopServer();
	expect(attempts).toBe(2);
});

test("server cleanup task shares one attempt across shutdown reasons", async () => {
	const complete = Promise.withResolvers<void>();
	const cleanup = mock(async ({ reason }: { reason: string }) => {
		await complete.promise;
		return { success: true, reason, pid: process.pid, durationMs: 0 };
	});
	const shutdown = createShutdownTask(cleanup);
	const first = shutdown({ reason: "signal" });
	const second = shutdown({ reason: "desktop_quit" });
	expect(second).toBe(first);
	complete.resolve();
	await first;
	expect(cleanup).toHaveBeenCalledTimes(1);
	expect(cleanup).toHaveBeenCalledWith({ reason: "signal" });
});
