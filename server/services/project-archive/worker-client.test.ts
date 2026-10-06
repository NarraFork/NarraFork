import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ShutdownActivityTracker } from "../../lib/shutdown-activity";
import {
	createPrivateArchiveWorkerLifecycle,
	type PrivateArchiveWorkerKind,
	privateArchiveWorkerSpecifiers,
} from "./worker-client";

test("source URLs stay relative to the project archive module, not the working directory", () => {
	for (const kind of ["legacy-sync", "legacy-import"] as const) {
		expect(
			privateArchiveWorkerSpecifiers(
				kind,
				false,
				"file:///source/server/services/project-archive/worker-client.ts",
			),
		).toEqual([`file:///source/server/services/project-archive/${kind}-worker.ts`]);
	}
});

test("compiled URLs probe embedded server-root and flattened bundles on Unix and Windows", () => {
	for (const moduleUrl of ["file:///$bunfs/root/main.js", "file:///C:/%7EBUN/root/main.js"]) {
		for (const kind of ["legacy-sync", "legacy-import"] as const) {
			expect(privateArchiveWorkerSpecifiers(kind, true, moduleUrl)).toEqual([
				new URL(`./services/project-archive/${kind}-worker.js`, moduleUrl).href,
				new URL(`./server/services/project-archive/${kind}-worker.js`, moduleUrl).href,
				new URL(`./${kind}-worker.js`, moduleUrl).href,
			]);
		}
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeWorker extends EventEmitter {
	readonly termination = deferred<number>();
	terminateCalls = 0;
	terminate() {
		this.terminateCalls++;
		return this.termination.promise;
	}
	ready() {
		this.emit("message", { ready: "private-archive-worker-v1" });
	}
}

const kinds: PrivateArchiveWorkerKind[] = ["legacy-sync", "legacy-import"];
function fixture(prepare: (worker: FakeWorker) => void = () => {}) {
	const workers: FakeWorker[] = [];
	const lifecycle = createPrivateArchiveWorkerLifecycle(() => {
		const worker = new FakeWorker();
		prepare(worker);
		workers.push(worker);
		return worker;
	});
	const start = (kind: PrivateArchiveWorkerKind = "legacy-sync") =>
		lifecycle.start(kind, new AbortController().signal, Date.now() + 10_000);
	return { workers, lifecycle, start };
}

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("both project archive kinds are tracked and shutdown waits for every deferred termination", async () => {
	const { workers, lifecycle, start } = fixture();
	const starts = kinds.map((kind) => start(kind));
	for (const worker of workers) worker.ready();
	expect(await Promise.all(starts)).toEqual(workers);
	const shutdown = lifecycle.shutdown();
	expect(lifecycle.shutdown()).toBe(shutdown);
	let finished = false;
	void shutdown.then(() => {
		finished = true;
	});
	await flush();
	expect(workers.map((worker) => worker.terminateCalls)).toEqual([1, 1]);
	expect(finished).toBe(false);
	workers[0].termination.resolve(0);
	await flush();
	expect(finished).toBe(false);
	workers[1].termination.resolve(0);
	await shutdown;
	expect(finished).toBe(true);
	expect(workers.every((worker) => worker.listenerCount("exit") === 0)).toBe(true);
});

test("closed admission creates zero workers for every kind", async () => {
	const { workers, lifecycle, start } = fixture();
	await lifecycle.shutdown();
	for (const kind of kinds) await expect(start(kind)).rejects.toThrow("shutting down");
	expect(workers).toHaveLength(0);
});

test("a ready message racing shutdown cannot return a worker or enter fallback", async () => {
	const { workers, lifecycle, start } = fixture();
	const startup = start().then(
		() => "returned a worker",
		(error: Error) => error.message,
	);
	workers[0].ready();
	const shutdown = lifecycle.shutdown();
	await flush();
	workers[0].termination.resolve(0);
	await shutdown;
	expect(await startup).toContain("shutting down");
	for (const kind of kinds) await expect(start(kind)).rejects.toThrow("shutting down");
	expect(workers).toHaveLength(1);
	expect(workers[0].terminateCalls).toBe(1);
});

test("shutdown cancels pending ready and shares termination without waiting for startup timeout", async () => {
	const { workers, lifecycle, start } = fixture();
	const startup = start().then(
		() => "returned a worker",
		(error: Error) => error.message,
	);
	const shutdown = lifecycle.shutdown();
	await flush();
	expect(workers[0].terminateCalls).toBe(1);
	expect(workers[0].listenerCount("message")).toBe(0);
	expect(workers[0].listenerCount("error")).toBe(0);
	expect(workers[0].listenerCount("exit")).toBe(1);
	workers[0].termination.resolve(0);
	await shutdown;
	expect(await startup).toContain("shutting down");
	expect(workers).toHaveLength(1);
});

test("normal exit removes the worker from the registry before shutdown", async () => {
	const { workers, lifecycle, start } = fixture();
	const startup = start("legacy-sync");
	workers[0].ready();
	await startup;
	workers[0].emit("exit", 0);
	await lifecycle.shutdown();
	expect(workers[0].terminateCalls).toBe(0);
	expect(workers[0].listenerCount("exit")).toBe(0);
});

test("ready and termination cleanup preserve caller message/error/exit listeners", async () => {
	const onMessage = () => {};
	const onError = () => {};
	const onExit = () => {};
	const { workers, lifecycle, start } = fixture((worker) => {
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
	});
	const startup = start();
	workers[0].ready();
	await startup;
	expect(workers[0].listeners("message")).toEqual([onMessage]);
	expect(workers[0].listeners("error")).toEqual([onError]);
	expect(workers[0].listeners("exit")).toContain(onExit);
	expect(workers[0].listenerCount("exit")).toBe(2);
	const shutdown = lifecycle.shutdown();
	workers[0].termination.resolve(0);
	await shutdown;
	expect(workers[0].listeners("message")).toEqual([onMessage]);
	expect(workers[0].listeners("error")).toEqual([onError]);
	expect(workers[0].listeners("exit")).toEqual([onExit]);
});

test("failed termination waits for other workers, preserves unknown records and marks shutdown degraded", async () => {
	const { workers, lifecycle, start } = fixture();
	const starts = [start("legacy-sync"), start("legacy-import")];
	for (const worker of workers) worker.ready();
	await Promise.all(starts);
	const tracker = new ShutdownActivityTracker();
	tracker.markDrainComplete();
	const shutdown = lifecycle.shutdown();
	const outcome = shutdown.then(
		() => tracker.recordStep("privateArchiveWorkers.shutdown", "ok"),
		() => tracker.recordStep("privateArchiveWorkers.shutdown", "failed"),
	);
	await flush();
	workers[0].termination.reject(new Error("termination proof missing"));
	await flush();
	expect(tracker.summary().steps).toHaveLength(0);
	workers[1].termination.resolve(0);
	await outcome;
	expect(tracker.isCleanShutdown()).toBe(false);
	expect(tracker.summary().degradedSteps).toEqual([
		{ label: "privateArchiveWorkers.shutdown", outcome: "failed" },
	]);
	expect(workers[0].listenerCount("exit")).toBe(1);
	expect(workers[1].listenerCount("exit")).toBe(0);
	expect(lifecycle.shutdown()).toBe(shutdown);
	await expect(start()).rejects.toThrow("shutting down");
	expect(workers).toHaveLength(2);
	expect(workers.map((worker) => worker.terminateCalls)).toEqual([1, 1]);
});

test("startup terminal failure retains unknown worker so shutdown cannot falsely succeed", async () => {
	const onMessage = () => {};
	const onError = () => {};
	const onExit = () => {};
	const { workers, lifecycle, start } = fixture((worker) => {
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
	});
	const startup = start().then(
		() => "returned a worker",
		(error: Error) => error.message,
	);
	workers[0].emit("error", new Error("unavailable"));
	await flush();
	workers[0].termination.reject(new Error("termination proof missing"));
	expect(await startup).toBe("termination proof missing");
	expect(workers[0].listeners("message")).toEqual([onMessage]);
	expect(workers[0].listeners("error")).toEqual([onError]);
	expect(workers[0].listeners("exit")).toContain(onExit);
	expect(workers[0].listenerCount("exit")).toBe(2);
	const shutdown = lifecycle.shutdown();
	await expect(shutdown).rejects.toThrow("Private archive worker termination failed");
	expect(lifecycle.shutdown()).toBe(shutdown);
	await expect(start()).rejects.toThrow("shutting down");
	expect(workers).toHaveLength(1);
	expect(workers[0].terminateCalls).toBe(1);
});
