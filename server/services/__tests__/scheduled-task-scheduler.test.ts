import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const hot = new Map<string, unknown>();
const timers = new Map<string, unknown>();
let recovery: Promise<void> = Promise.resolve();
let polls = 0;
let dueReads = 0;
let notifier: unknown;
const errors: string[] = [];
const notices = async () => {};
mock.module("../../lib/hot-safe", () => ({
	hotSafe: (key: string, make: () => unknown) => {
		if (!hot.has(key)) hot.set(key, make());
		return hot.get(key);
	},
	hotTimer: (key: string, make: () => unknown) => {
		timers.set(key, make());
	},
	hotTimerClear: (key: string) => {
		timers.delete(key);
	},
}));
mock.module("../../lib/logger", () => ({
	logger: { info: () => {}, error: (message: string) => errors.push(message) },
}));
mock.module("../scheduled-task-notify", () => ({ notifyScheduledRunChanged: notices }));
mock.module("../scheduled-task-run-service", () => ({
	setScheduledRunNotifier: (value: unknown) => {
		notifier = value;
	},
}));
mock.module("../scheduled-task-run-tracker", () => ({
	pollScheduledRuns: async () => {
		polls++;
	},
}));
mock.module("../scheduled-task-service", () => ({
	scheduledTaskService: {
		recoverOnStartup: () => recovery,
		reconcilePausedTasks: async () => {},
		listDue: async () => {
			dueReads++;
			return [];
		},
		runTask: async () => {},
	},
}));
const originalInterval = globalThis.setInterval;
// No real timers: this suite proves lifecycle admission without waiting 30 seconds.
globalThis.setInterval = ((callback: () => void, ms: number) => ({
	callback,
	ms,
})) as unknown as typeof setInterval;
const { startScheduledTaskScheduler, stopScheduledTaskScheduler } = await import(
	"../scheduled-task-scheduler"
);
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};
afterEach(() => {
	stopScheduledTaskScheduler();
	recovery = Promise.resolve();
	polls = 0;
	dueReads = 0;
	notifier = undefined;
	errors.length = 0;
});
afterAll(() => {
	globalThis.setInterval = originalInterval;
});

describe("scheduler startup and shutdown", () => {
	test("watchdog starts immediately, dispatch waits for completed catch-up", async () => {
		const pending = Promise.withResolvers<void>();
		recovery = pending.promise;
		startScheduledTaskScheduler();
		expect(polls).toBe(1);
		expect(notifier).toBe(notices);
		expect(dueReads).toBe(0);
		expect(timers.has("scheduled-task-run-tracker")).toBe(true);
		expect(timers.has("scheduled-task-scheduler")).toBe(false);
		pending.resolve();
		await flush();
		expect(dueReads).toBe(1);
		expect(timers.has("scheduled-task-scheduler")).toBe(true);
	});
	test("stopping while catch-up is pending cannot recreate either timer", async () => {
		const pending = Promise.withResolvers<void>();
		recovery = pending.promise;
		startScheduledTaskScheduler();
		stopScheduledTaskScheduler();
		pending.resolve();
		await flush();
		expect(timers.size).toBe(0);
		expect(dueReads).toBe(0);
	});
	test("a replaced startup does not mount its stale timer", async () => {
		const old = Promise.withResolvers<void>();
		const current = Promise.withResolvers<void>();
		recovery = old.promise;
		startScheduledTaskScheduler();
		recovery = current.promise;
		startScheduledTaskScheduler();
		old.resolve();
		await flush();
		expect(dueReads).toBe(0);
		current.resolve();
		await flush();
		expect(dueReads).toBe(1);
		expect(timers.size).toBe(2);
	});
	test("failed catch-up does not dispatch, but existing runs retain a watchdog", async () => {
		recovery = Promise.reject(new Error("database not ready"));
		startScheduledTaskScheduler();
		await flush();
		expect(errors).toHaveLength(1);
		expect(dueReads).toBe(0);
		expect(timers.has("scheduled-task-run-tracker")).toBe(true);
		expect(timers.has("scheduled-task-scheduler")).toBe(false);
	});
});
