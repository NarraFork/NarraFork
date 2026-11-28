import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as workerThreads from "node:worker_threads";
import * as compiledWorker from "../../compiled-worker";
import { logger } from "../../logger";
import * as measurementCore from "../measure-tree";

type Mode =
	| "constructor"
	| "startup-error"
	| "startup-exit"
	| "wrong-ready"
	| "send"
	| "ready-timeout"
	| "task-timeout"
	| "task-error"
	| "task-exit"
	| "worker-error"
	| "worker-abort"
	| "invalid-result"
	| "null-response"
	| "invalid-progress"
	| "unknown-response"
	| "healthy";

interface TaskMessage {
	type: string;
	requestId: string;
	roots?: string[];
}

let mode: Mode = "healthy";
let constructions = 0;
const workers: FaultWorker[] = [];
const modeSequence: Mode[] = [];

/** Same EventEmitter/message API as node Worker; no directory walk is implemented here. */
class FaultWorker extends EventEmitter {
	readonly mode = modeSequence.shift() ?? mode;
	terminated = false;
	exited = false;
	override emit(event: string, ...args: unknown[]): boolean {
		if (event === "exit") this.exited = true;
		return super.emit(event, ...args);
	}
	messages: TaskMessage[] = [];

	constructor(_specifier: unknown) {
		super();
		constructions++;
		if (this.mode === "constructor") throw new Error("injected constructor failure");
		workers.push(this);
		queueMicrotask(() => {
			if (this.terminated || this.mode === "ready-timeout") return;
			if (this.mode === "startup-error") this.emit("error", new Error("injected startup error"));
			else if (this.mode === "startup-exit") this.emit("exit", 0);
			else this.emit("message", { type: this.mode === "wrong-ready" ? "wrong" : "ready" });
		});
	}

	postMessage(message: TaskMessage): void {
		this.messages.push(message);
		if (message.type !== "measure") return;
		if (this.mode === "send") throw new Error("injected postMessage failure");
		if (this.mode === "task-timeout") return;
		queueMicrotask(() => {
			if (this.terminated) return;
			if (this.mode === "null-response") this.emit("message", null);
			else if (this.mode === "invalid-progress")
				this.emit("message", {
					type: "progress",
					requestId: message.requestId,
					entriesScanned: "invalid",
					sizeBytes: 0,
				});
			else if (this.mode === "unknown-response")
				this.emit("message", {
					type: "unexpected",
					requestId: message.requestId,
				});
			else if (this.mode === "task-error") {
				this.emit("error", new Error("injected runtime error"));
			} else if (this.mode === "task-exit") {
				this.emit("exit", 3);
			} else if (this.mode === "worker-error" || this.mode === "worker-abort") {
				this.emit("message", {
					type: "error",
					requestId: message.requestId,
					message: "injected task failure",
					aborted: this.mode === "worker-abort",
				});
			} else {
				this.emit("message", {
					type: "result",
					requestId: message.requestId,
					roots:
						this.mode === "invalid-result"
							? []
							: message.roots?.map(() => ({
									sizeBytes: 123,
									entriesScanned: 1,
									truncated: false,
								})),
				});
			}
		});
	}

	terminate(): Promise<number> {
		this.terminated = true;
		queueMicrotask(() => this.emit("exit", 0));
		return Promise.resolve(0);
	}
}

mock.module("node:worker_threads", () => ({ ...workerThreads, Worker: FaultWorker }));

const {
	DirectoryMeasureAbortedError,
	FsScanWorkerUnavailableError,
	measureDirectoriesOffThread,
	closeFsScanWorkers,
	resetFsScanWorkersForTest,
	fsScanWorkerStats,
} = await import("../client");
const realSetTimeout = globalThis.setTimeout;
let hostWalk: ReturnType<typeof spyOn<typeof measurementCore, "measureDirectoryTrees">>;
let timeoutBudgets: number[] = [];

beforeEach(async () => {
	await resetFsScanWorkersForTest();
	mode = "healthy";
	constructions = 0;
	workers.length = 0;
	modeSequence.length = 0;
	timeoutBudgets = [];
	hostWalk = spyOn(measurementCore, "measureDirectoryTrees").mockRejectedValue(
		new Error("the server must never call the directory walk"),
	);
	spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
		const [callback, delay, ...callbackArgs] = args;
		if (delay && (delay <= 5_000 || delay >= 899_000)) {
			timeoutBudgets.push(delay);
			if (delay >= 899_000) {
				const expires = Date.now() + delay;
				return realSetTimeout(() => {
					spyOn(Date, "now").mockReturnValue(expires);
					if (typeof callback === "function") callback(...callbackArgs);
				}, 10);
			}
			return realSetTimeout(callback, 1, ...callbackArgs);
		}
		return realSetTimeout(callback, delay, ...callbackArgs);
	}) as typeof setTimeout);
});

afterEach(async () => {
	await closeFsScanWorkers();
	expect(hostWalk).not.toHaveBeenCalled();
	expect(fsScanWorkerStats()).toMatchObject({ active: 0, queued: 0, workers: 0 });
	for (const worker of workers) expect(worker.exited).toBe(true);
	mock.restore();
});

const failures: Array<[Mode, string]> = [
	["constructor", "injected constructor failure"],
	["startup-error", "injected startup error"],
	["startup-exit", "exited before ready"],
	["wrong-ready", "sent no ready handshake"],
	["send", "injected postMessage failure"],
	["ready-timeout", "did not become ready"],
	["task-timeout", "deadline exceeded"],
	["task-error", "injected runtime error"],
	["task-exit", "exited before completing (code 3)"],
	["worker-error", "injected task failure"],
	["invalid-result", "returned invalid measurements"],
	["null-response", "returned an invalid response"],
	["invalid-progress", "returned invalid progress"],
	["unknown-response", "returned an invalid response"],
];

test("failure diagnostics contain fixed scalars, never an entry path or original error", async () => {
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	mode = "constructor";
	const error = await measureDirectoriesOffThread(["/PRIVATE_SCAN_ROOT"]).catch(
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(FsScanWorkerUnavailableError);
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn).toHaveBeenCalledWith(
		"Filesystem scan worker unavailable; directory measurement failed",
		{ kind: "fs-scan", outcome: "failed" },
	);
	const logged = JSON.stringify(warn.mock.calls);
	for (const secret of [
		"PRIVATE_SCAN_ROOT",
		"injected constructor failure",
		"file://",
		import.meta.dir,
	])
		expect(logged).not.toContain(secret);
});
test("a throwing diagnostic sink preserves the failure and the exit barrier", async () => {
	spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("diagnostic sink failed");
	});
	mode = "task-error";
	const result = await measureDirectoriesOffThread(["/never-walk-on-host"]).catch(
		(error: unknown) => error,
	);
	expect(result).toBeInstanceOf(FsScanWorkerUnavailableError);
	expect((result as Error).cause).toMatchObject({ message: "injected runtime error" });
	expect(workers[0].exited).toBe(true);
	expect(constructions).toBe(1);
});
describe("filesystem worker failure isolation", () => {
	for (const [failureMode, reason] of failures) {
		test(`${failureMode} rejects both the first request and the cooldown request without a host walk`, async () => {
			mode = failureMode;
			const first = await measureDirectoriesOffThread(["/never-walk-on-host"]).catch(
				(error: unknown) => error,
			);
			expect(first).toBeInstanceOf(FsScanWorkerUnavailableError);
			expect((first as Error).message).toContain(reason);
			expect((first as Error).cause).toBeInstanceOf(Error);
			expect(constructions).toBe(1);

			const second = await measureDirectoriesOffThread(["/never-walk-on-host"]).catch(
				(error: unknown) => error,
			);
			expect(second).toBe(first);
			expect(constructions).toBe(1);
			if (failureMode === "ready-timeout" || failureMode === "task-timeout") {
				expect(timeoutBudgets.some((ms) => ms >= 899_000 && ms <= 900_000)).toBe(true);
				expect(timeoutBudgets.some((ms) => ms > 0 && ms <= 5_000)).toBe(true);
			}
		});
	}

	test("tries each compiled candidate at most once and retains every failure as its cause", async () => {
		spyOn(compiledWorker, "compiledWorkerSpecifiers").mockReturnValue(["first", "second", "third"]);
		mode = "startup-error";
		const error = await measureDirectoriesOffThread(["root"]).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(FsScanWorkerUnavailableError);
		expect((error as Error).cause).toBeInstanceOf(Error);
		for (const candidate of ["first", "second", "third"])
			expect(((error as Error).cause as Error).message).toContain(candidate);
		expect(constructions).toBe(3);
		await expect(measureDirectoriesOffThread(["root"])).rejects.toBe(error);
		expect(constructions).toBe(3);
	});

	test("a healthy isolated candidate still succeeds after earlier candidates fail", async () => {
		const candidates = spyOn(compiledWorker, "compiledWorkerSpecifiers").mockReturnValue([
			"first",
			"second",
			"third",
		]);
		modeSequence.push("constructor", "wrong-ready", "healthy");
		expect(await measureDirectoriesOffThread(["root"])).toHaveLength(1);
		expect(constructions).toBe(3);
		expect(workers.at(-1)?.mode).toBe("healthy");
		expect(await measureDirectoriesOffThread(["root"])).toHaveLength(1);
		expect(constructions).toBe(4);
		expect(candidates).toHaveBeenCalledTimes(2);
	});

	test("retries in a new worker only after the cooldown expires", async () => {
		mode = "task-error";
		await expect(measureDirectoriesOffThread(["root"])).rejects.toBeInstanceOf(
			FsScanWorkerUnavailableError,
		);
		mode = "healthy";
		await expect(measureDirectoriesOffThread(["root"])).rejects.toBeInstanceOf(
			FsScanWorkerUnavailableError,
		);
		expect(constructions).toBe(1);
		const now = Date.now();
		spyOn(Date, "now").mockReturnValue(now + 5_001);
		expect(await measureDirectoriesOffThread(["root"])).toEqual([
			{ sizeBytes: 123, entriesScanned: 1, truncated: false },
		]);
		expect(constructions).toBe(2);
		expect(fsScanWorkerStats()).toMatchObject({ active: 0, queued: 0 });
	});

	test("an already-aborted request creates no worker, even during cooldown", async () => {
		mode = "constructor";
		await expect(measureDirectoriesOffThread(["root"])).rejects.toBeInstanceOf(
			FsScanWorkerUnavailableError,
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			measureDirectoriesOffThread(["root"], { signal: controller.signal }),
		).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
		expect(constructions).toBe(1);
	});

	test("cancellation while starting terminates the worker without poisoning retries", async () => {
		mode = "ready-timeout";
		const controller = new AbortController();
		const pending = measureDirectoriesOffThread(["root"], { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
		expect(workers.every((worker) => worker.messages.length === 0)).toBe(true);
		mode = "healthy";
		expect(await measureDirectoriesOffThread(["root"])).toHaveLength(1);
		expect(constructions).toBe(1);
	});

	test("worker-reported cancellation does not become unavailability or a retry", async () => {
		mode = "worker-abort";
		await expect(measureDirectoriesOffThread(["root"])).rejects.toBeInstanceOf(
			DirectoryMeasureAbortedError,
		);
		expect(fsScanWorkerStats().failed).toBe(1);
		expect(constructions).toBe(1);
	});

	test("a queued cancellation settles without waiting for active workers", async () => {
		mode = "task-timeout";
		const controllers = Array.from({ length: 4 }, () => new AbortController());
		const active = controllers.map((controller) =>
			measureDirectoriesOffThread(["root"], { signal: controller.signal }).catch(
				(error: unknown) => error,
			),
		);
		const queuedController = new AbortController();
		const queued = measureDirectoriesOffThread(["queued"], { signal: queuedController.signal });
		for (let i = 0; i < 12; i++) await Promise.resolve();
		expect(constructions).toBe(4);
		expect(fsScanWorkerStats().queued).toBe(1);
		queuedController.abort();
		await expect(queued).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
		expect(fsScanWorkerStats().queued).toBe(0);
		expect(constructions).toBe(4);
		for (const controller of controllers) controller.abort();
		for (const result of await Promise.all(active)) {
			expect(result).toBeInstanceOf(DirectoryMeasureAbortedError);
		}
	});

	test("runtime failure never replays a dispatched scan on another compiled entry", async () => {
		spyOn(compiledWorker, "compiledWorkerSpecifiers").mockReturnValue(["runtime-a", "runtime-b"]);
		modeSequence.push("task-error", "healthy");
		const error = await measureDirectoriesOffThread(["root"]).catch((error) => error);
		expect(error).toBeInstanceOf(FsScanWorkerUnavailableError);
		expect(constructions).toBe(1);
		expect(workers[0].messages.filter((message) => message.type === "measure")).toHaveLength(1);
	});

	test("bounded queue and permanent shutdown reject waiters without dispatching them", async () => {
		mode = "task-timeout";
		const active = Array.from({ length: 4 }, () =>
			measureDirectoriesOffThread(["root"]).catch((error) => error),
		);
		const queued = Array.from({ length: 32 }, () =>
			measureDirectoriesOffThread(["queued"]).catch((error) => error),
		);
		const full = await measureDirectoriesOffThread(["overflow"]).catch((error) => error);
		expect(full.code).toBe("TASK_QUEUE_FULL");
		for (let i = 0; i < 12; i++) await Promise.resolve();
		expect(constructions).toBe(4);
		await closeFsScanWorkers();
		await Promise.all([...active, ...queued]);
		const stopped = await measureDirectoriesOffThread(["closed"]).catch((error) => error);
		expect(stopped.code).toBe("WORKER_POOL_CLOSED");
		const empty = await measureDirectoriesOffThread([]).catch((error) => error);
		expect(empty.code).toBe("WORKER_POOL_CLOSED");
		expect(constructions).toBe(4);
	});

	test("normal HMR retains the same pool and production close still blocks old exports", async () => {
		const key = Symbol.for("narrafork.fsScan.gate");
		const current = Reflect.get(globalThis, key);
		const pool = current.pool;
		const reloaded = await import(`../client.ts?current=${crypto.randomUUID()}`);
		expect(reloaded.measureDirectoriesOffThread).not.toBe(measureDirectoriesOffThread);
		expect(Reflect.get(globalThis, key)).toBe(current);
		expect(current.pool).toBe(pool);
		expect(await reloaded.measureDirectoriesOffThread(["root"])).toHaveLength(1);
		await reloaded.closeFsScanWorkers();
		const stopped = await measureDirectoriesOffThread(["closed"]).catch((error) => error);
		expect(stopped.code).toBe("WORKER_POOL_CLOSED");
		expect(constructions).toBe(1);
	});

	test("legacy HMR counters cannot prove exit, even at zero; owner evidence is retained", async () => {
		const key = Symbol.for("narrafork.fsScan.gate");
		const current = Reflect.get(globalThis, key);
		const legacy = { active: 0, waiters: [] };
		Reflect.set(globalThis, key, legacy);
		try {
			const upgraded = await import(`../client.ts?legacy=${crypto.randomUUID()}`);
			expect(upgraded.measureDirectoriesOffThread).not.toBe(measureDirectoriesOffThread);
			const error = await upgraded
				.measureDirectoriesOffThread(["root"])
				.catch((error: Error) => error);
			expect(error.message).toContain("process restart required");
			const closed = await upgraded.closeFsScanWorkers().catch((error: Error) => error);
			expect(closed.message).toContain("process restart required");
			const reset = await upgraded.resetFsScanWorkersForTest().catch((error: Error) => error);
			expect(reset.message).toContain("process restart required");
			expect(Reflect.get(globalThis, key)).toBe(legacy);
			expect(legacy).toMatchObject({ active: 0, waiters: [] });
			expect(constructions).toBe(0);
		} finally {
			Reflect.set(globalThis, key, current);
		}
	});

	test("client has no runtime dependency on the directory-walk implementation", () => {
		const source = readFileSync(new URL("../client.ts", import.meta.url), "utf8");
		expect(source).not.toContain('from "./measure-tree"');
		expect(source).not.toContain('import("./measure-tree")');
		expect(source).not.toContain("measureDirectoryTrees(");
	});
});
