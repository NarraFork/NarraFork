import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as workerThreads from "node:worker_threads";
import * as compiledWorker from "../../compiled-worker";
import { hotSafe } from "../../hot-safe";
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
			if (this.mode === "task-error") {
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
		return Promise.resolve(0);
	}
}

mock.module("node:worker_threads", () => ({ ...workerThreads, Worker: FaultWorker }));

const { DirectoryMeasureAbortedError, FsScanWorkerUnavailableError, measureDirectoriesOffThread } =
	await import("../client");

interface GateState {
	active: number;
	waiters: Array<() => void>;
	unavailableError?: Error;
	retryAfter?: number;
	resolvedSpecifier?: string;
}

const gate = hotSafe<GateState>("narrafork.fsScan.gate", () => ({ active: 0, waiters: [] }));
const realSetTimeout = globalThis.setTimeout;
let hostWalk: ReturnType<typeof spyOn<typeof measurementCore, "measureDirectoryTrees">>;
let timeoutBudgets: number[] = [];

beforeEach(() => {
	mode = "healthy";
	constructions = 0;
	workers.length = 0;
	modeSequence.length = 0;
	gate.unavailableError = undefined;
	gate.retryAfter = undefined;
	gate.resolvedSpecifier = undefined;
	timeoutBudgets = [];
	hostWalk = spyOn(measurementCore, "measureDirectoryTrees").mockRejectedValue(
		new Error("the server must never call the directory walk"),
	);
	spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
		const [callback, delay, ...callbackArgs] = args;
		if (delay === 5_000 || delay === 15 * 60 * 1000) {
			timeoutBudgets.push(delay);
			return realSetTimeout(callback, 5, ...callbackArgs);
		}
		return realSetTimeout(callback, delay, ...callbackArgs);
	}) as typeof setTimeout);
});

afterEach(() => {
	expect(hostWalk).not.toHaveBeenCalled();
	expect(gate.active).toBe(0);
	expect(gate.waiters).toHaveLength(0);
	for (const worker of workers) expect(worker.terminated).toBe(true);
	mock.restore();
});

const failures: Array<[Mode, string]> = [
	["constructor", "injected constructor failure"],
	["startup-error", "injected startup error"],
	["startup-exit", "exited before completing (code 0)"],
	["wrong-ready", "sent no ready handshake"],
	["send", "injected postMessage failure"],
	["ready-timeout", "did not become ready"],
	["task-timeout", "timed out"],
	["task-error", "injected runtime error"],
	["task-exit", "exited before completing (code 3)"],
	["worker-error", "injected task failure"],
	["invalid-result", "returned invalid measurements"],
];

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
			if (failureMode === "ready-timeout") expect(timeoutBudgets).toEqual([5_000]);
			if (failureMode === "task-timeout") expect(timeoutBudgets).toEqual([5_000, 900_000]);
		});
	}

	test("tries each compiled candidate at most once and retains every failure as its cause", async () => {
		spyOn(compiledWorker, "compiledWorkerSpecifiers").mockReturnValue(["first", "second", "third"]);
		mode = "startup-error";
		const error = await measureDirectoriesOffThread(["root"]).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(FsScanWorkerUnavailableError);
		expect((error as Error).cause).toBeInstanceOf(AggregateError);
		expect(((error as Error).cause as AggregateError).errors).toHaveLength(3);
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
		expect(gate.resolvedSpecifier).toBe("third");
		expect(await measureDirectoriesOffThread(["root"])).toHaveLength(1);
		expect(constructions).toBe(4);
		expect(candidates).toHaveBeenCalledTimes(1);
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
		expect(gate.unavailableError).toBeUndefined();
		expect(gate.retryAfter).toBeUndefined();
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
		expect(workers[0]?.messages.some((message) => message.type === "cancel")).toBe(true);
		mode = "healthy";
		expect(await measureDirectoriesOffThread(["root"])).toHaveLength(1);
		expect(constructions).toBe(2);
	});

	test("worker-reported cancellation does not become unavailability or a retry", async () => {
		mode = "worker-abort";
		await expect(measureDirectoriesOffThread(["root"])).rejects.toBeInstanceOf(
			DirectoryMeasureAbortedError,
		);
		expect(gate.unavailableError).toBeUndefined();
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
		expect(constructions).toBe(4);
		expect(gate.waiters).toHaveLength(1);
		queuedController.abort();
		await expect(queued).rejects.toBeInstanceOf(DirectoryMeasureAbortedError);
		expect(gate.waiters).toHaveLength(0);
		expect(constructions).toBe(4);
		for (const controller of controllers) controller.abort();
		for (const result of await Promise.all(active)) {
			expect(result).toBeInstanceOf(DirectoryMeasureAbortedError);
		}
	});

	test("client has no runtime dependency on the directory-walk implementation", () => {
		const source = readFileSync(new URL("../client.ts", import.meta.url), "utf8");
		expect(source).not.toContain('from "./measure-tree"');
		expect(source).not.toContain('import("./measure-tree")');
		expect(source).not.toContain("measureDirectoryTrees(");
	});
});
