import { afterAll, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const originalDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...originalDb, db, sqlite }));
const { backgroundTaskService: service } = await import("../background-task-service");
afterAll(() => {
	mock.restore();
	sqlite.close();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("shutdown cancels all producers before awaiting persistence and complete finally", async () => {
	const first = new AbortController();
	const second = new AbortController();
	const persistence = deferred();
	const finalizer = deferred();
	const order: string[] = [];
	first.signal.addEventListener("abort", () => order.push("first"));
	second.signal.addEventListener("abort", () => order.push("second"));
	service.registerAbortController("mock-first", first);
	service.registerAbortController("mock-second", second);
	service.trackBashLifecycle(persistence.promise.finally(() => finalizer.promise));
	service.freezeForShutdown();
	let drained = false;
	const drain = service.killAll().then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(order).toEqual(["first", "second"]);
	expect(drained).toBe(false);
	persistence.resolve();
	await Promise.resolve();
	expect(drained).toBe(false);
	finalizer.resolve();
	await drain;
	expect(service.getShutdownState().pending).toBe(0);
	expect(() => service.assertExecutionAdmission()).toThrow("shutting down");
	service.unregisterAbortController("mock-first");
	service.unregisterAbortController("mock-second");
});

test("drain cancellation stops waiting without dropping pending ownership", async () => {
	const work = deferred();
	service.trackBashLifecycle(work.promise);
	const abort = new AbortController();
	const drain = service.drainForShutdown(abort.signal);
	abort.abort(new Error("test deadline"));
	await expect(drain).rejects.toThrow("test deadline");
	expect(service.getShutdownState().pending).toBe(1);
	work.resolve();
	await service.drainForShutdown();
});

test("checkpoint preservation drains exited tails and reports active ownership without killing", async () => {
	const active = deferred();
	const terminal = deferred();
	service.trackBashLifecycle(active.promise, () => true);
	service.trackBashLifecycle(terminal.promise, () => false);
	let finished = false;
	const drain = service.drainForShutdown(undefined, { preserveRunning: true });
	const observed = drain.catch((error) => {
		finished = true;
		return error;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	terminal.resolve();
	expect(await observed).toBeInstanceOf(Error);
	expect(service.getShutdownState().pending).toBe(1);
	active.resolve();
	await service.drainForShutdown();
});

test("checkpoint drain rescans a process that exits during another terminal tail", async () => {
	const first = deferred();
	const second = deferred();
	let running = true;
	service.trackBashLifecycle(first.promise);
	service.trackBashLifecycle(second.promise, () => running);
	let drained = false;
	const drain = service.drainForShutdown(undefined, { preserveRunning: true }).then(() => {
		drained = true;
	});
	running = false;
	first.resolve();
	await Promise.resolve();
	expect(drained).toBe(false);
	second.resolve();
	await drain;
	expect(service.getShutdownState().pending).toBe(0);
});

test("settled persistence failures remain visible to shutdown", async () => {
	service.trackBashLifecycle(Promise.reject(new Error("mock persistence failed")));
	await Promise.resolve();
	await expect(service.drainForShutdown()).rejects.toThrow("mock persistence failed");
	expect(service.getShutdownState().failureCount).toBe(1);
});
