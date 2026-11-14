import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Worker } from "node:worker_threads";
import * as compiled from "../lib/compiled-worker";
import { logger } from "../lib/logger";
import * as spawn from "../lib/spawn";
import { WorkerCleanupError, WorkerHandle } from "../lib/worker-runtime/lifecycle";
import {
	closeGitCurrentBaselineWorkers,
	gitCurrentBaselineReader,
	resetGitCurrentBaselineWorkersForTests,
} from "./git-current-baseline";
import {
	closeGitLineStatsWorkers,
	getGitLineStats,
	resetGitLineStatsWorkersForTests,
} from "./git-line-stats";

const spies: Array<{ mockRestore(): void }> = [];
const handles: WorkerHandle<Worker>[] = [];
const controls: AbortController[] = [];
const signal = () => {
	const controller = new AbortController();
	controls.push(controller);
	return controller;
};
async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Fixture observation timed out");
		await Bun.sleep(1);
	}
}
function fixture(mode: string) {
	const state = new Int32Array(new SharedArrayBuffer(20));
	const launch = WorkerHandle.thread;
	spies.push(
		spyOn(WorkerHandle, "thread").mockImplementation(() => {
			const handle = launch(new URL("./git-current-baseline-session.fixture.ts", import.meta.url), {
				workerData: { state: state.buffer, mode },
			});
			handles.push(handle);
			return handle;
		}),
	);
	return state;
}
function fakeGit() {
	spies.push(
		spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			if (options.cmd.includes("ls-files")) options.stdoutStream?.onChunk(Buffer.from("one\0"));
			return { stdout: "", stderr: "", exitCode: 0 };
		}),
	);
}
const baseline = (controller = signal()) =>
	gitCurrentBaselineReader.verifyBlobs([], "/unused", controller.signal);

beforeEach(async () => {
	await resetGitCurrentBaselineWorkersForTests();
	await resetGitLineStatsWorkersForTests();
});
afterEach(async () => {
	for (const controller of controls.splice(0)) controller.abort(new Error("test cleanup"));
	await Promise.all([closeGitCurrentBaselineWorkers(), closeGitLineStatsWorkers()]);
	for (const handle of handles.splice(0)) await handle.close();
	for (const spy of spies.splice(0).reverse()) spy.mockRestore();
});

test("baseline has two real slots, no queue; cancellation kills owned child before worker retirement", async () => {
	const state = fixture("cleanup");
	const first = signal();
	const second = signal();
	const pending = [
		baseline(first).catch((error) => error),
		baseline(second).catch((error) => error),
	];
	await until(() => Atomics.load(state, 1) === 2 && Atomics.load(state, 4) > 0);
	await expect(baseline()).rejects.toThrow("reader_busy");
	let exits = 0;
	for (const handle of handles) void handle.exited.then(() => exits++);
	first.abort(new Error("cancelled by viewer"));
	second.abort(new Error("cancelled by viewer"));
	const results = await Promise.all(pending);
	expect(results.every((error) => error.message === "cancelled by viewer")).toBe(true);
	expect(Atomics.load(state, 2)).toBe(2);
	expect(Atomics.load(state, 3)).toBe(1);
	expect(exits).toBe(2);
	expect(() => process.kill(Atomics.load(state, 4), 0)).toThrow();
	expect(handles).toHaveLength(2);
});

test("line-stat forced cancellation retains its slot through the original 1s grace and actual exit", async () => {
	fakeGit();
	const state = fixture("ignore");
	const active = signal();
	const first = getGitLineStats("/unused", active.signal).catch((error) => error);
	await until(() => Atomics.load(state, 1) === 1);
	const original = handles[0].resource.terminate.bind(handles[0].resource);
	const stopping = Promise.withResolvers<void>();
	const exitGate = Promise.withResolvers<void>();
	spies.push(
		spyOn(handles[0].resource, "terminate").mockImplementation(async () => {
			stopping.resolve();
			await exitGate.promise;
			return original();
		}),
	);
	const cancelledAt = Date.now();
	active.abort(new Error("stop running"));
	await stopping.promise;
	expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(950);
	let resolved = false;
	void first.then(() => {
		resolved = true;
	});
	const waiting = signal();
	const second = getGitLineStats("/unused", waiting.signal).catch((error) => error);
	await Bun.sleep(5);
	expect(resolved).toBe(false);
	expect(handles).toHaveLength(1);
	waiting.abort(new Error("queued cancellation"));
	expect((await second).message).toBe("queued cancellation");
	exitGate.resolve();
	expect((await first).message).toBe("stop running");
	expect(Atomics.load(state, 1)).toBe(1);
});

test("creation failure, not-ready timeout and running crash never read files on the main thread", async () => {
	const launch = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		throw new Error("injected create failure");
	});
	spies.push(launch);
	await expect(baseline()).rejects.toThrow("injected create failure");
	launch.mockRestore();
	let state = fixture("not-ready");
	const connect = compiled.connectCompiledWorker;
	const readyBudget = spyOn(compiled, "connectCompiledWorker").mockImplementation(
		(entries, options = {}) => connect(entries, { ...options, deadlineAt: Date.now() + 40 }),
	);
	spies.push(readyBudget);
	await expect(baseline()).rejects.toThrow("ready");
	expect(readyBudget).toHaveBeenCalled();
	expect(Atomics.load(state, 1)).toBe(0);
	await Promise.all(handles.map((handle) => handle.exited));
	readyBudget.mockRestore();
	spies[1].mockRestore();
	state = fixture("crash");
	await expect(baseline()).rejects.toThrow("injected worker crash");
	expect(Atomics.load(state, 1)).toBe(1);
	await Promise.all(handles.map((handle) => handle.exited));
});

test("malformed primitive packets reject and retire rather than escaping the protocol listener", async () => {
	fakeGit();
	fixture("invalid");
	await expect(baseline()).rejects.toThrow("Invalid Git reader reply");
	await expect(getGitLineStats("/unused")).rejects.toThrow("Invalid Git reader reply");
	expect(handles).toHaveLength(2);
	await Promise.all(handles.map((handle) => handle.exited));
});

test("startup cleanup failure preserves its Handle and blocks replacement until the real exit", async () => {
	fakeGit();
	fixture("not-ready");
	const connect = compiled.connectCompiledWorker;
	spies.push(
		spyOn(compiled, "connectCompiledWorker").mockImplementation((entries, options = {}) =>
			connect(entries, { ...options, deadlineAt: Date.now() + 40 }),
		),
	);
	const pending = getGitLineStats("/unused").catch((error) => error);
	await until(() => handles.length === 1);
	const resource = handles[0].resource;
	const terminate = resource.terminate.bind(resource);
	spies.push(spyOn(resource, "terminate").mockRejectedValue(new Error("stop failed before exit")));
	const failure = await pending;
	expect(failure).toBeInstanceOf(WorkerCleanupError);
	expect(Object.keys(failure)).not.toContain("handle");
	const waiting = signal();
	const next = getGitLineStats("/unused", waiting.signal).catch((error) => error);
	await Bun.sleep(5);
	expect(handles).toHaveLength(1);
	waiting.abort(new Error("cancel waiting for orphan exit"));
	expect((await next).message).toBe("cancel waiting for orphan exit");
	let closed = false;
	const closing = closeGitLineStatsWorkers().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	await terminate();
	await handles[0].exited;
	await closing;
	// Its intentionally failed close promise remains rejected; observed exit, not a retry, freed it.
	handles.splice(0, 1);
});

test("line-stat execution timeout keeps its original budget and waits for cancel acknowledgement plus exit", async () => {
	fakeGit();
	const state = fixture("cleanup");
	const original = setTimeout;
	const adjusted = Object.assign((...args: Parameters<typeof setTimeout>) => {
		if (args[1] === 30_000) args[1] = 10;
		return original(...args);
	}, original);
	const timeout = spyOn(globalThis, "setTimeout").mockImplementation(adjusted);
	spies.push(timeout);
	await expect(getGitLineStats("/unused")).rejects.toThrow("timed out");
	expect(timeout.mock.calls.some((call) => call[1] === 30_000)).toBe(true);
	expect(Atomics.load(state, 2)).toBe(1);
	expect(Atomics.load(state, 3)).toBe(1);
	await handles[0].exited;
});

test("line-stat metadata cache reuses its worker and the original 60s idle timer awaits actual retirement", async () => {
	fakeGit();
	fixture("ok");
	let idle: (() => void) | undefined;
	const original = setTimeout;
	const observed = Object.assign((...args: Parameters<typeof setTimeout>) => {
		if (args[1] === 60_000) idle = args[0] as () => void;
		return original(...args);
	}, original);
	spies.push(spyOn(globalThis, "setTimeout").mockImplementation(observed));
	await getGitLineStats("/unused");
	await getGitLineStats("/unused");
	expect(handles).toHaveLength(1);
	expect(idle).toBeDefined();
	idle?.();
	await handles[0].exited;
	await getGitLineStats("/unused");
	expect(handles).toHaveLength(2);
});

test("throwing fixed-scalar diagnostic sink cannot replace a successful Git result or skip cleanup", async () => {
	fakeGit();
	fixture("ok");
	let clock = 0;
	spies.push(
		spyOn(performance, "now").mockImplementation(() => {
			clock += 3000;
			return clock;
		}),
	);
	const log = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("diagnostic sink failure");
	});
	spies.push(log);
	expect(await getGitLineStats("/unused")).toMatchObject({ complete: true, linesAdded: 2 });
	expect(log).toHaveBeenCalled();
	await closeGitLineStatsWorkers();
	await handles[0].exited;
});

test("line-stat close also waits for its pre-worker Git children and rejects new reads before spawn", async () => {
	let began = 0;
	let cleaned = 0;
	const git = spyOn(spawn, "safeSpawn").mockImplementation(async ({ signal }) => {
		began++;
		await new Promise<void>((resolve) =>
			signal?.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }),
		);
		cleaned++;
		return { stdout: "", stderr: "", exitCode: 143, terminationReason: "abort" };
	});
	spies.push(git);
	const pending = getGitLineStats("/unused").catch((error) => error);
	await until(() => began === 4);
	await closeGitLineStatsWorkers();
	expect(cleaned).toBe(4);
	expect(await pending).toBeInstanceOf(Error);
	await expect(getGitLineStats("/unused")).rejects.toThrow("closed");
	expect(began).toBe(4);
});

test("close waits for pending startup, disables both clients permanently and survives module reload", async () => {
	const state = fixture("not-ready");
	fakeGit();
	const pending = baseline().catch((error) => error);
	await until(() => Atomics.load(state, 0) === 1);
	await closeGitCurrentBaselineWorkers();
	await expect(pending).resolves.toBeInstanceOf(Error);
	await handles[0].exited;
	await closeGitLineStatsWorkers();
	await expect(baseline()).rejects.toThrow("closed");
	await expect(getGitLineStats("/unused")).rejects.toThrow("closed");
	const next = await import(`./git-current-baseline.ts?generation=${Date.now()}`);
	await expect(
		next.gitCurrentBaselineReader.verifyBlobs([], "/unused", signal().signal),
	).rejects.toThrow("closed");
	expect(handles).toHaveLength(1);
	expect(Atomics.load(state, 1)).toBe(0);
});
