import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { type ConnectedWorker, connectCompiledWorker } from "../../../compiled-worker";
import { WorkerCleanupError, WorkerHandle } from "../../../worker-runtime/lifecycle";
import {
	__resetStructuralWorkersForTest,
	closeStructuralWorkers,
	invalidateStructuralWorkers,
	runStructuralTask,
	verifyStructuralGrammar,
} from "../worker-client";
import { STRUCTURAL_GRAMMAR_LIMIT, STRUCTURAL_INPUT_LIMIT } from "../worker-protocol";

const doc = {
	filePath: "/private/project/source.ts",
	text: "const secret = 1;",
	languageId: "typescript",
};
type Connector = typeof connectCompiledWorker;
type Mode = "ok" | "hang" | "crash" | "bad-id" | "bad-generation" | "bad-result" | "bad-error";

class Transport extends EventEmitter {
	mode: Mode = "ok";
	stopCalls = 0;
	posted: unknown[] = [];
	deferExit = false;
	didExit = false;
	private exit!: (code: number) => void;
	readonly exited = new Promise<number>((resolve) => {
		this.exit = resolve;
	});
	readonly handle = new WorkerHandle(this as unknown as Worker, this.exited, () => {
		this.stopCalls++;
		if (!this.deferExit) this.finishExit();
	});
	finishExit(): void {
		if (this.didExit) return;
		this.didExit = true;
		this.exit(0);
	}
	postMessage(message: {
		requestId: string;
		generation: number;
		task: { operation: string; doc?: unknown };
	}): void {
		this.posted.push(message);
		queueMicrotask(() => {
			if (this.mode === "hang") return;
			if (this.mode === "crash") {
				this.finishExit();
				return;
			}
			const response: Record<string, unknown> = {
				requestId: message.requestId,
				generation: message.generation,
				result: message.task.operation === "verifyGrammar" ? null : "full",
			};
			if (this.mode === "bad-id") response.requestId = "not-the-current-id";
			if (this.mode === "bad-generation") response.generation = message.generation - 1;
			if (this.mode === "bad-result") response.result = { arbitrary: "secret source" };
			if (this.mode === "bad-error") {
				delete response.result;
				response.error = { code: "STRUCTURAL_TASK_FAILED", message: doc.text };
			}
			this.emit("message", response);
		});
	}
	connection(): ConnectedWorker {
		return { worker: this as unknown as Worker, handle: this.handle, specifier: "private-fixture" };
	}
}

let transports: Transport[];
let nextMode: Mode;
let deferExit: boolean;
let connectOptions: Parameters<Connector>[1][];
const connector: Connector = async (_specifiers, options) => {
	connectOptions.push(options);
	const transport = new Transport();
	transport.mode = nextMode;
	transport.deferExit = deferExit;
	transports.push(transport);
	return transport.connection();
};
async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected lifecycle transition was not observed");
}
function failure<T>(promise: Promise<T>): Promise<{ code: string; message: string }> {
	return promise.then(
		() => {
			throw new Error("Expected task failure");
		},
		(error) => error,
	);
}

beforeEach(async () => {
	transports = [];
	nextMode = "ok";
	deferExit = false;
	connectOptions = [];
	delete process.env.NF_STRUCTURAL_WORKER_DISABLED;
	await __resetStructuralWorkersForTest({ connect: connector, timeoutMs: 100, readyTimeoutMs: 30 });
});
afterEach(async () => {
	delete process.env.NF_STRUCTURAL_WORKER_DISABLED;
	for (const transport of transports) transport.finishExit();
	await closeStructuralWorkers();
});

describe("structural worker ownership", () => {
	test("reuses one worker, strips AbortSignal, and never imports a computation core", async () => {
		const signal = new AbortController().signal;
		expect(await runStructuralTask("supports", { ...doc, signal })).toBe("full");
		expect(await runStructuralTask("supports", doc)).toBe("full");
		expect(transports).toHaveLength(1);
		expect(transports[0]?.posted).toHaveLength(2);
		expect((transports[0]?.posted[0] as { task: { doc: object } }).task.doc).not.toHaveProperty(
			"signal",
		);
		expect(connectOptions[0]?.timeoutMs).toBe(30);
		const source = await readFile(new URL("../worker-client.ts", import.meta.url), "utf8");
		expect(source).not.toContain('from "./tree-sitter-core"');
		expect(source).not.toContain("handleStructuralRequest");
	});

	test("creation failure is fixed, redacted, and never executes locally", async () => {
		await __resetStructuralWorkersForTest({
			connect: async () => {
				throw new Error(doc.text + doc.filePath);
			},
		});
		const error = await failure(runStructuralTask("supports", doc));
		expect(error.code).toBe("STRUCTURAL_WORKER_STARTUP");
		expect(error.message).not.toContain(doc.text);
		expect(error.message).not.toContain(doc.filePath);
		expect(transports).toHaveLength(0);
	});

	test("failed readiness remains an explicit failure", async () => {
		await __resetStructuralWorkersForTest({
			connect: async (_entries, options) => {
				expect(options?.timeoutMs).toBe(12);
				throw new Error("worker was not ready");
			},
			readyTimeoutMs: 12,
		});
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_STARTUP",
		);
		expect(transports).toHaveLength(0);
	});

	test("unconfirmed startup cleanup quarantines capacity across invalidation until exit", async () => {
		let calls = 0;
		const orphan = new Transport();
		orphan.deferExit = true;
		transports.push(orphan);
		await __resetStructuralWorkersForTest({
			connect: async (entries, options) => {
				if (++calls === 1) throw new WorkerCleanupError(orphan.handle, new Error(doc.filePath));
				expect(orphan.didExit).toBe(true);
				return connector(entries, options);
			},
		});
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_STARTUP",
		);
		invalidateStructuralWorkers();
		const second = runStructuralTask("supports", doc);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);
		orphan.finishExit();
		expect(await second).toBe("full");
		expect(calls).toBe(2);
	});

	test("unexpected exit fails and replacement is a new worker", async () => {
		nextMode = "crash";
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_EXITED",
		);
		nextMode = "ok";
		expect(await runStructuralTask("supports", doc)).toBe("full");
		expect(transports).toHaveLength(2);
		expect(transports[0]?.didExit).toBe(true);
	});

	for (const mode of ["bad-id", "bad-generation", "bad-result", "bad-error"] as const) {
		test(`invalid protocol (${mode}) terminates the worker`, async () => {
			nextMode = mode;
			const error = await failure(runStructuralTask("supports", doc));
			expect(error.code).toBe("STRUCTURAL_WORKER_PROTOCOL");
			expect(error.message).not.toContain(doc.text);
			expect(transports[0]?.stopCalls).toBe(1);
			expect(transports[0]?.didExit).toBe(true);
		});
	}

	test("deadline covers execution and retains capacity until actual exit", async () => {
		await __resetStructuralWorkersForTest({ connect: connector, timeoutMs: 25 });
		nextMode = "hang";
		deferExit = true;
		const first = failure(runStructuralTask("supports", doc));
		await until(() => transports.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 35));
		expect(transports[0]?.stopCalls).toBe(1);
		nextMode = "ok";
		deferExit = false;
		const second = runStructuralTask("supports", doc);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(transports).toHaveLength(1);
		transports[0]?.finishExit();
		expect((await first).code).toBe("STRUCTURAL_WORKER_TIMEOUT");
		expect(await second).toBe("full");
		expect(transports).toHaveLength(2);
	});

	test("cancel waits for actual exit before admitting the next task", async () => {
		nextMode = "hang";
		deferExit = true;
		const controller = new AbortController();
		const first = failure(runStructuralTask("supports", { ...doc, signal: controller.signal }));
		await until(() => transports[0]?.posted.length === 1);
		controller.abort(new Error(doc.text));
		nextMode = "ok";
		deferExit = false;
		const second = runStructuralTask("supports", doc);
		await until(() => transports[0]?.stopCalls === 1);
		expect(transports).toHaveLength(1);
		transports[0]?.finishExit();
		expect((await first).code).toBe("STRUCTURAL_WORKER_CANCELLED");
		expect(await second).toBe("full");
		expect(transports).toHaveLength(2);
	});

	test("a queued task expires on its original deadline without reaching the worker", async () => {
		await __resetStructuralWorkersForTest({ connect: connector, timeoutMs: 25 });
		nextMode = "hang";
		deferExit = true;
		const first = failure(runStructuralTask("supports", doc));
		await until(() => transports[0]?.posted.length === 1);
		const second = await failure(runStructuralTask("supports", doc));
		expect(second.code).toBe("STRUCTURAL_WORKER_TIMEOUT");
		expect(transports).toHaveLength(1);
		expect(transports[0]?.posted).toHaveLength(1);
		transports[0]?.finishExit();
		expect((await first).code).toBe("STRUCTURAL_WORKER_TIMEOUT");
	});

	test("queued cancellation never terminates another task's active worker", async () => {
		nextMode = "hang";
		const first = failure(runStructuralTask("supports", doc));
		await until(() => transports[0]?.posted.length === 1);
		const controller = new AbortController();
		const second = failure(runStructuralTask("supports", { ...doc, signal: controller.signal }));
		controller.abort();
		expect((await second).code).toBe("STRUCTURAL_WORKER_CANCELLED");
		expect(transports[0]?.stopCalls).toBe(0);
		expect(transports[0]?.posted).toHaveLength(1);
		await closeStructuralWorkers();
		await first;
	});

	test("disabled environment fails without creating or locally executing work", async () => {
		process.env.NF_STRUCTURAL_WORKER_DISABLED = "1";
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_DISABLED",
		);
		expect((await failure(verifyStructuralGrammar(new Uint8Array(1)))).code).toBe(
			"STRUCTURAL_WORKER_DISABLED",
		);
		expect(transports).toHaveLength(0);
	});

	test("queue count is bounded to 32 waiters", async () => {
		nextMode = "hang";
		const first = failure(runStructuralTask("supports", doc));
		await until(() => transports[0]?.posted.length === 1);
		const queued = Array.from({ length: 32 }, () => failure(runStructuralTask("supports", doc)));
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_QUEUE_FULL",
		);
		await closeStructuralWorkers();
		expect((await first).code).toBe("STRUCTURAL_WORKER_CLOSED");
		await Promise.all(queued);
	});

	test("queue bytes are bounded to 16MiB and grammar to 8MiB", async () => {
		nextMode = "hang";
		const first = failure(runStructuralTask("supports", doc));
		await until(() => transports[0]?.posted.length === 1);
		const bytes = new Uint8Array(STRUCTURAL_GRAMMAR_LIMIT);
		const queued = [
			failure(verifyStructuralGrammar(bytes)),
			failure(verifyStructuralGrammar(bytes)),
		];
		expect((await failure(verifyStructuralGrammar(bytes))).code).toBe(
			"STRUCTURAL_WORKER_QUEUE_FULL",
		);
		expect(
			(await failure(verifyStructuralGrammar(new Uint8Array(STRUCTURAL_GRAMMAR_LIMIT + 1)))).code,
		).toBe("STRUCTURAL_INPUT_TOO_LARGE");
		await closeStructuralWorkers();
		await Promise.all([first, ...queued]);
	});

	test("oversize documents fail before worker creation", async () => {
		expect(
			(
				await failure(
					runStructuralTask("supports", { ...doc, text: "x".repeat(STRUCTURAL_INPUT_LIMIT + 1) }),
				)
			).code,
		).toBe("STRUCTURAL_INPUT_TOO_LARGE");
		expect(transports).toHaveLength(0);
	});

	test("source escaping does not reduce the exact 2MiB UTF-8 input allowance", async () => {
		const text = '\n"'.repeat(STRUCTURAL_INPUT_LIMIT / 2);
		expect(Buffer.byteLength(text)).toBe(STRUCTURAL_INPUT_LIMIT);
		expect(await runStructuralTask("supports", { ...doc, text })).toBe("full");
	});

	test("metadata has a separate budget", async () => {
		expect(
			(await failure(runStructuralTask("supports", { ...doc, filePath: "x".repeat(65_537) }))).code,
		).toBe("STRUCTURAL_INPUT_TOO_LARGE");
		expect(transports).toHaveLength(0);
	});

	test("queued options are snapshotted before caller mutation", async () => {
		nextMode = "hang";
		const first = runStructuralTask("supports", doc);
		await until(() => transports[0]?.posted.length === 1);
		const args = { selector: { symbol: "original" } };
		const second = runStructuralTask("supports", doc, args);
		args.selector.symbol = "mutated";
		const transport = transports[0];
		if (!transport) throw new Error("Missing test transport");
		transport.mode = "ok";
		const original = transport.posted[0] as { requestId: string; generation: number };
		transport.emit("message", {
			requestId: original.requestId,
			generation: original.generation,
			result: "full",
		});
		expect(await first).toBe("full");
		expect(await second).toBe("full");
		expect(
			(transport.posted[1] as { task: { args: { selector: { symbol: string } } } }).task.args
				.selector.symbol,
		).toBe("original");
	});

	test("grammar views clone only their bounded slice", async () => {
		const bytes = new Uint8Array(1024 * 1024).subarray(10, 20);
		expect(await verifyStructuralGrammar(bytes)).toBeNull();
		const posted = transports[0]?.posted[0] as { task: { bytes: Uint8Array } };
		expect(posted.task.bytes.byteLength).toBe(10);
		expect(posted.task.bytes.buffer.byteLength).toBe(10);
	});

	test("generation invalidation rejects running and queued work; no overlapping owner", async () => {
		nextMode = "hang";
		deferExit = true;
		const first = failure(runStructuralTask("supports", doc));
		await until(() => transports[0]?.posted.length === 1);
		const queued = failure(runStructuralTask("supports", doc));
		invalidateStructuralWorkers();
		nextMode = "ok";
		deferExit = false;
		const second = failure(runStructuralTask("supports", doc));
		await until(() => transports[0]?.stopCalls === 1);
		// Even repeated clears cannot bypass the first worker's pending real exit.
		invalidateStructuralWorkers();
		const third = runStructuralTask("supports", doc);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(transports).toHaveLength(1);
		const old = transports[0]?.posted[0] as { requestId: string; generation: number };
		transports[0]?.emit("message", {
			requestId: old.requestId,
			generation: old.generation,
			result: "full",
		});
		transports[0]?.finishExit();
		expect((await first).code).toBe("STRUCTURAL_WORKER_STALE");
		expect((await queued).code).toBe("STRUCTURAL_WORKER_STALE");
		expect((await second).code).toBe("STRUCTURAL_WORKER_STALE");
		expect(await third).toBe("full");
		expect(transports).toHaveLength(2);
	});

	test("invalidate without a worker does not start one; shutdown is permanent", async () => {
		invalidateStructuralWorkers();
		invalidateStructuralWorkers();
		expect(transports).toHaveLength(0);
		await closeStructuralWorkers();
		invalidateStructuralWorkers();
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_CLOSED",
		);
		expect(transports).toHaveLength(0);
	});

	test("idle eviction confirms exit and next task creates a new worker", async () => {
		await __resetStructuralWorkersForTest({ connect: connector, idleTimeoutMs: 10 });
		expect(await runStructuralTask("supports", doc)).toBe("full");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(transports[0]?.didExit).toBe(true);
		expect(await runStructuralTask("supports", doc)).toBe("full");
		expect(transports).toHaveLength(2);
	});
});

describe("native structural worker transport", () => {
	const fixture = new URL("./worker-fixtures/transport.ts", import.meta.url).href;
	async function setup(mode: string, timeoutMs = 350) {
		const started = new SharedArrayBuffer(4);
		const connected: ConnectedWorker[] = [];
		const exited: boolean[] = [];
		let next = mode;
		await __resetStructuralWorkersForTest({
			timeoutMs,
			readyTimeoutMs: 200,
			connect: async (_entries, options) => {
				// A replacement must never be constructed while the previous native handle is live.
				if (connected.length) expect(exited[connected.length - 1]).toBe(true);
				const connection = await connectCompiledWorker([fixture], {
					...options,
					workerOptions: { workerData: { mode: next, started } },
				});
				const index = connected.length;
				connected.push(connection);
				exited.push(false);
				void connection.handle.exited.then(() => {
					exited[index] = true;
				});
				return connection;
			},
		});
		return {
			connected,
			exited,
			started,
			replaceWith: (mode: string) => {
				next = mode;
			},
		};
	}
	async function waitForStarted(started: SharedArrayBuffer): Promise<void> {
		for (let i = 0; i < 200; i++) {
			if (Atomics.load(new Int32Array(started), 0) === 1) return;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		throw new Error("Native worker did not begin its isolated computation");
	}

	test("real ready failure cannot run a task on the main thread", async () => {
		await setup("never-ready");
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_STARTUP",
		);
	});

	test("real crash is explicit and replacement waits for the exit event", async () => {
		const state = await setup("crash");
		expect((await failure(runStructuralTask("supports", doc))).code).toBe(
			"STRUCTURAL_WORKER_EXITED",
		);
		expect(state.exited[0]).toBe(true);
		state.replaceWith("ok");
		expect(await runStructuralTask("supports", doc)).toBe("full");
		expect(state.connected).toHaveLength(2);
	});

	test("real synchronous worker hang is terminated on timeout before capacity is reused", async () => {
		const state = await setup("hang");
		const first = failure(runStructuralTask("supports", doc));
		await waitForStarted(state.started);
		expect((await first).code).toBe("STRUCTURAL_WORKER_TIMEOUT");
		expect(state.exited[0]).toBe(true);
		state.replaceWith("ok");
		expect(await runStructuralTask("supports", doc)).toBe("full");
	});

	test("real synchronous worker hang is terminated on cancellation", async () => {
		const state = await setup("hang");
		const controller = new AbortController();
		const first = failure(runStructuralTask("supports", { ...doc, signal: controller.signal }));
		await waitForStarted(state.started);
		controller.abort();
		expect((await first).code).toBe("STRUCTURAL_WORKER_CANCELLED");
		expect(state.exited[0]).toBe(true);
		state.replaceWith("ok");
		expect(await runStructuralTask("supports", doc)).toBe("full");
	});
});
