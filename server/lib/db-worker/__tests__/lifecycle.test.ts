import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../logger";
import * as failures from "../failure";
import {
	DB_WORKER_MAX_QUEUE,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../pool";

const workerGlobal = globalThis as unknown as {
	Worker: (...args: ConstructorParameters<typeof Worker>) => Worker;
};
const urls: string[] = [];
const restores: Array<() => void> = [];
const task = { kind: "storageScanContext" } as const;
const unusedDb = "/must-not-open-on-main-thread.sqlite";
function fixture(source: string) {
	const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
	urls.push(url);
	setDbWorkerSpecifiersForTest([url]);
}
function successFixture() {
	fixture(
		`self.onmessage = ({data}) => postMessage({type:'result', requestId:data.requestId, result:42}); postMessage({type:'ready'});`,
	);
}
function observeWorker() {
	const RealWorker = globalThis.Worker;
	const posted: unknown[] = [];
	let terminated = 0;
	const spy = spyOn(workerGlobal, "Worker").mockImplementation((...args) => {
		const worker = new RealWorker(...args);
		const send = worker.postMessage.bind(worker);
		const terminate = worker.terminate.bind(worker);
		spyOn(worker, "postMessage").mockImplementation((message) => {
			posted.push(message);
			send(message);
		});
		spyOn(worker, "terminate").mockImplementation(() => {
			terminated++;
			return terminate();
		});
		return worker;
	});
	restores.push(() => spy.mockRestore());
	return { posted, terminations: () => terminated };
}
beforeEach(() => {
	resetDbWorkerPoolForTest();
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	const log = spyOn(logger, "warn").mockImplementation(() => {});
	restores.push(() => log.mockRestore());
});
afterEach(() => {
	shutdownDbWorkerPool();
	for (const restore of restores.splice(0).reverse()) restore();
	for (const url of urls.splice(0)) URL.revokeObjectURL(url);
	delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
});

test.each([
	"abort",
	"deadline",
	"shutdown",
])("cold startup %s releases reservations without dispatch or spawn-failure poisoning", async (mode) => {
	fixture("self.onmessage = () => {}; setInterval(() => {}, 1000);");
	const observed = observeWorker();
	const controller = new AbortController();
	const pending = runReadTask(unusedDb, task, {
		timeoutMs: mode === "deadline" ? 20 : 2000,
		signal: controller.signal,
	});
	if (mode === "abort") controller.abort();
	if (mode === "shutdown") shutdownDbWorkerPool();
	await expect(pending).rejects.toThrow(
		mode === "abort" ? "aborted" : mode === "deadline" ? "timed out" : "pool_shutdown",
	);
	expect(
		observed.posted.filter((message) => (message as { type?: string }).type === "task"),
	).toHaveLength(0);
	expect(observed.terminations()).toBe(1);
	expect(getDbWorkerPoolStats()).toMatchObject({
		workers: 0,
		starting: 0,
		claimed: 0,
		queued: 0,
		spawnFailures: 0,
	});
	successFixture();
	expect(await runReadTask(unusedDb, task)).toBe(42);
});

test("a no-ready worker hits the startup budget, not the execution budget", async () => {
	fixture("self.onmessage = () => {}; setInterval(() => {}, 1000);");
	const observed = observeWorker();
	const original = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		fn: TimerHandler,
		ms?: number,
		...args: unknown[]
	) => original(fn, ms === 10_000 ? 15 : ms, ...args)) as typeof setTimeout);
	restores.push(() => timer.mockRestore());
	await expect(runReadTask(unusedDb, task, { timeoutMs: 20_000 })).rejects.toThrow(
		"worker_spawn_failed",
	);
	expect(timer.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true);
	expect(observed.posted).toEqual([]);
	expect(getDbWorkerPoolStats()).toMatchObject({ starting: 0, claimed: 0, spawnFailures: 1 });
});

test("queue has an explicit bounded overload and cancellation drains every entry", async () => {
	fixture("self.onmessage = () => {}; setInterval(() => {}, 1000);");
	const controller = new AbortController();
	const held = runReadTask(unusedDb, task, { signal: controller.signal }).catch((error) => error);
	const queued = Array.from({ length: DB_WORKER_MAX_QUEUE }, () =>
		runReadTask(unusedDb, task, { signal: controller.signal }).catch((error) => error),
	);
	await Promise.resolve();
	expect(getDbWorkerPoolStats().queued).toBe(DB_WORKER_MAX_QUEUE);
	await expect(runReadTask(unusedDb, task)).rejects.toMatchObject({
		code: "DB_READ_TASK_OVERLOADED",
	});
	controller.abort();
	await Promise.all([held, ...queued]);
	expect(getDbWorkerPoolStats()).toMatchObject({
		workers: 0,
		starting: 0,
		claimed: 0,
		queued: 0,
		spawnFailures: 0,
	});
});

test("frozen pool validates missing, mismatched and matching worker identities before dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "db-worker-build-"));
	try {
		const build = await Bun.build({
			entrypoints: [join(import.meta.dir, "../failure.ts")],
			target: "bun",
			define: { __NARRAFORK_RUNTIME_BUILD_ID__: JSON.stringify("frozen-build") },
		});
		expect(build.success).toBe(true);
		const modulePath = join(root, "frozen-failure.mjs");
		await Bun.write(modulePath, build.outputs[0]);
		const frozen = await import(modulePath);
		const check = spyOn(failures, "assertWorkerBuildId").mockImplementation(
			frozen.assertWorkerBuildId,
		);
		restores.push(() => check.mockRestore());
		const observed = observeWorker();
		for (const buildId of [undefined, null, "stale", "frozen-build"]) {
			resetDbWorkerPoolForTest();
			observed.posted.length = 0;
			fixture(
				`self.onmessage=({data})=>postMessage({type:'result',requestId:data.requestId,result:42});postMessage(${JSON.stringify({ type: "ready", buildId })});`,
			);
			if (buildId === "frozen-build") expect(await runReadTask(unusedDb, task)).toBe(42);
			else {
				await expect(runReadTask(unusedDb, task)).rejects.toThrow("worker_spawn_failed");
				expect(observed.posted).toHaveLength(0);
			}
			expect(check).toHaveBeenCalledWith(buildId);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	"dispatch",
	"messageerror",
])("%s failure releases a claimed worker and all listeners without a local fallback", async (mode) => {
	successFixture();
	const RealWorker = globalThis.Worker;
	let terminations = 0;
	const worker = spyOn(workerGlobal, "Worker").mockImplementation((...args) => {
		const instance = new RealWorker(...args);
		const terminate = instance.terminate.bind(instance);
		spyOn(instance, "terminate").mockImplementation(() => {
			terminations++;
			return terminate();
		});
		if (mode === "dispatch")
			spyOn(instance, "postMessage").mockImplementation(() => {
				throw new Error("dispatch failed");
			});
		else queueMicrotask(() => instance.dispatchEvent(new MessageEvent("messageerror")));
		return instance;
	});
	restores.push(() => worker.mockRestore());
	await expect(runReadTask(unusedDb, task)).rejects.toThrow(
		mode === "dispatch" ? "dispatch failed" : "worker_spawn_failed",
	);
	expect(terminations).toBe(1);
	expect(getDbWorkerPoolStats()).toMatchObject({ workers: 0, starting: 0, claimed: 0, queued: 0 });
	worker.mockRestore();
	expect(await runReadTask(unusedDb, task)).toBe(42);
});

test("runtime diagnostics exclude native driver text and bound the retained stack", () => {
	const error = new TypeError(
		"SELECT secret_prompt FROM secrets postgres://name:password@db/private",
	);
	error.stack = `${error.message}\n${"    at read (/worker.ts:12:4)\n".repeat(10_000)}`;
	const runtime = failures.workerFailureDetails(error, false);
	expect(JSON.stringify(runtime)).not.toContain("secret_prompt");
	expect(JSON.stringify(runtime)).not.toContain("name:password");
	expect(runtime.stack).toContain("/worker.ts:12:4");
	expect(runtime.stack?.length).toBeLessThanOrEqual(2048);
	expect(runtime.stack?.split("\n")).toHaveLength(8);
	expect(failures.safeSqliteCode({ code: "SQLITE_BUSY secret" })).toBeUndefined();
	expect(failures.isSqliteLockError({ code: "SQLITE_ERROR", message: "SQLITE_BUSY" })).toBe(false);
});

test("source hot reload upgrades old pool state and safely retires workers without detach", async () => {
	successFixture();
	expect(await runReadTask(unusedDb, task)).toBe(42);
	const legacy = Reflect.get(globalThis, Symbol.for("narrafork.dbWorkerPool")) as {
		starting?: Set<unknown>;
		generation?: number;
		workers: Array<{ detach?: () => void }>;
	};
	delete legacy.starting;
	delete legacy.generation;
	delete legacy.workers[0].detach;
	const reloaded = (await import(
		`../pool.ts?legacy-shape=${Date.now()}`
	)) as typeof import("../pool");
	expect(await reloaded.runReadTask(unusedDb, task)).toBe(42);
	expect(legacy.starting).toBeInstanceOf(Set);
	expect(Reflect.get(legacy, "generation")).toBe(0);
	reloaded.shutdownDbWorkerPool();
	expect(reloaded.getDbWorkerPoolStats()).toMatchObject({ workers: 0, starting: 0, claimed: 0 });
	expect(await reloaded.runReadTask(unusedDb, task)).toBe(42);
	reloaded.shutdownDbWorkerPool();
	expect(reloaded.getDbWorkerPoolStats()).toMatchObject({
		workers: 0,
		starting: 0,
		claimed: 0,
		spawnFailures: 0,
	});
});

test("synchronous construction failure is diagnosed without leaking credentials", async () => {
	const spy = spyOn(workerGlobal, "Worker").mockImplementation(() => {
		throw new TypeError(
			"Cannot resolve fixture module postgres://alice:secret@host/db?token=abc password=private",
		);
	});
	restores.push(() => spy.mockRestore());
	await expect(runReadTask(unusedDb, task)).rejects.toThrow("worker_spawn_failed");
	expect(getDbWorkerPoolStats()).toMatchObject({ starting: 0, claimed: 0, spawnFailures: 1 });
	const logs = JSON.stringify((logger.warn as ReturnType<typeof spyOn>).mock.calls);
	expect(logs).toContain("Cannot resolve fixture module");
	expect(logs).not.toContain("alice:secret");
	expect(logs).not.toContain("password=private");
});
