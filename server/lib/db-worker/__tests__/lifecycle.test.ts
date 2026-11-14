import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { logger } from "../../logger";
import { RUNTIME_BUILD_ID } from "../../runtime-target";
import * as sqlTrace from "../../sql-trace";
import { WorkerHandle } from "../../worker-runtime/lifecycle";
import * as failures from "../failure";
import {
	DB_WORKER_MAX_QUEUE,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	resumeDbWorkerPool,
	runEphemeralReadTask,
	runReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../pool";
import { DB_WORKER_READY_TIMEOUT_MS } from "../protocol";

const task = { kind: "storageScanContext" } as const;
const unusedDb = "/must-not-open-on-main-thread.sqlite";
const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
let dir: string;
let handles: WorkerHandle<Worker>[];
let restores: Array<() => void>;
let posted: Array<{ type?: string; requestId?: string; traceParent?: string }>;
let nextSpawn: ReturnType<typeof deferred<void>>;
function fixture(body: string, announce = true) {
	const path = join(dir, `fixture-${Math.random()}.ts`);
	writeFileSync(
		path,
		`import { parentPort } from "node:worker_threads";\n${body}\n${announce ? 'parentPort.postMessage({type:"ready"});' : ""}`,
	);
	setDbWorkerSpecifiersForTest([pathToFileURL(path).href]);
}
const success = `parentPort.on("message", data => {
	if (data.type === "task") parentPort.postMessage({type:"result",requestId:data.requestId,result:42});
});`;
const hanging = `parentPort.on("message", () => {});`;
beforeEach(async () => {
	await resetDbWorkerPoolForTest();
	dir = mkdtempSync(join(tmpdir(), "nf-db-lifecycle-"));
	handles = [];
	restores = [];
	posted = [];
	nextSpawn = deferred();
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	const create = WorkerHandle.thread;
	const spawns = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
		const handle = create(entry, options);
		handles.push(handle);
		const send = handle.resource.postMessage.bind(handle.resource);
		spyOn(handle.resource, "postMessage").mockImplementation((message) => {
			posted.push(message);
			send(message);
		});
		nextSpawn.resolve();
		return handle;
	});
	const logs = spyOn(logger, "warn").mockImplementation(() => {});
	restores.push(
		() => spawns.mockRestore(),
		() => logs.mockRestore(),
	);
});
afterEach(async () => {
	await shutdownDbWorkerPool();
	for (const restore of restores.reverse()) restore();
	delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	delete process.env.NARRAFORK_DB_WORKER;
	rmSync(dir, { recursive: true, force: true });
});

// Native Bun promise matchers can starve same-thread worker events: settle first, then assert.
test.each([
	"abort",
	"deadline",
	"shutdown",
])("cold startup %s cleans real owners without dispatch or poisoning", async (mode) => {
	fixture(hanging, false);
	const controller = new AbortController();
	const pending = failureOf(
		runReadTask(unusedDb, task, {
			timeoutMs: mode === "deadline" ? 40 : 2000,
			signal: controller.signal,
		}),
	);
	await nextSpawn.promise;
	if (mode === "abort") controller.abort();
	if (mode === "shutdown") await shutdownDbWorkerPool();
	const error = await pending;
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain(
		mode === "abort" ? "aborted" : mode === "deadline" ? "timed out" : "pool_shutdown",
	);
	expect(posted.filter((message) => message.type === "task")).toHaveLength(0);
	expect(typeof (await handles[0]?.exited)).toBe("number");
	expect(getDbWorkerPoolStats()).toMatchObject({
		workers: 0,
		starting: 0,
		claimed: 0,
		queued: 0,
		spawnFailures: 0,
	});
	fixture(success);
	const result = await runReadTask(unusedDb, task);
	expect(result).toBe(42);
});

test("no-ready startup uses the bounded startup budget and a failed owner exits", async () => {
	fixture(hanging, false);
	const original = globalThis.setTimeout;
	// Entry resolution/creation consumes part of the shared absolute startup budget.
	const startupDelay = (ms: number | undefined) =>
		typeof ms === "number" &&
		ms > DB_WORKER_READY_TIMEOUT_MS - 1_000 &&
		ms <= DB_WORKER_READY_TIMEOUT_MS;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		fn: TimerHandler,
		ms?: number,
		...args: unknown[]
	) => original(fn, startupDelay(ms) ? 25 : ms, ...args)) as typeof setTimeout);
	restores.push(() => timer.mockRestore());
	const error = await failureOf(runReadTask(unusedDb, task, { timeoutMs: 20_000 }));
	expect(error).toMatchObject({ reason: "worker_spawn_failed" });
	expect(timer.mock.calls.some(([, ms]) => startupDelay(ms))).toBe(true);
	expect(posted.filter((message) => message.type === "task")).toHaveLength(0);
	expect(typeof (await handles[0]?.exited)).toBe("number");
	expect(getDbWorkerPoolStats()).toMatchObject({ starting: 0, claimed: 0, spawnFailures: 1 });
	expect((logger.warn as ReturnType<typeof spyOn>).mock.calls).toEqual([
		[
			"Database read worker failure",
			{
				entry: "db-read-worker",
				phase: "ready",
				buildId: RUNTIME_BUILD_ID,
				errorType: "WorkerStartupError",
				code: "TIMEOUT",
			},
		],
	]);
});

test("concurrent cold starts reserve shared permits before awaiting readiness", async () => {
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	fixture(`${success}\nawait Bun.sleep(80);`);
	const jobs = Array.from({ length: 6 }, () => runReadTask(unusedDb, task));
	await nextSpawn.promise;
	await Promise.resolve();
	expect(handles.length).toBe(2);
	expect(getDbWorkerPoolStats()).toMatchObject({ starting: 2, queued: 4 });
	const values = await Promise.all(jobs);
	expect(values).toEqual([42, 42, 42, 42, 42, 42]);
	expect(handles.length).toBe(2);
});

test("queue bounds overload and cancellation removes every waiter", async () => {
	fixture(hanging, false);
	const controller = new AbortController();
	const jobs = Array.from({ length: DB_WORKER_MAX_QUEUE + 1 }, () =>
		failureOf(runReadTask(unusedDb, task, { signal: controller.signal })),
	);
	const error = await failureOf(runReadTask(unusedDb, task));
	expect(error).toMatchObject({ code: "DB_READ_TASK_OVERLOADED" });
	expect(getDbWorkerPoolStats().queued).toBe(DB_WORKER_MAX_QUEUE);
	controller.abort();
	await Promise.all(jobs);
	expect(getDbWorkerPoolStats()).toMatchObject({
		workers: 0,
		starting: 0,
		claimed: 0,
		queued: 0,
		spawnFailures: 0,
	});
});

test("deduped subscriptions cancel locally and retain one DB execution", async () => {
	fixture(success);
	const controller = new AbortController();
	const first = failureOf(
		runReadTask(unusedDb, task, { dedupeKey: "same", signal: controller.signal }),
	);
	const second = runReadTask(unusedDb, task, { dedupeKey: "same" });
	controller.abort();
	const cancelled = await first;
	const value = await second;
	expect((cancelled as Error).message).toContain("aborted");
	expect(value).toBe(42);
	expect(posted.filter((message) => message.type === "task")).toHaveLength(1);
});

test("PG last-subscriber cancellation retains permit through terminal ACK then real exit", async () => {
	const accepted = deferred();
	fixture(`let active;
	parentPort.on("message", data => {
		if (data.type === "task") {
			if (data.params.kind !== "displayPageMessagesPostgres") {
				parentPort.postMessage({type:"result",requestId:data.requestId,result:42}); return;
			}
			active=data.requestId;
			parentPort.postMessage({type:"progress",requestId:active,tableName:"accepted",done:0,total:1});
		}
		if (data.type === "cancel") parentPort.postMessage({type:"progress",requestId:active,tableName:"cancel",done:0,total:1});
		if (data.type === "ack") parentPort.postMessage({type:"error",requestId:active,message:"cancelled"});
	});`);
	const one = new AbortController();
	const two = new AbortController();
	const pg = {
		kind: "displayPageMessagesPostgres",
		messageIds: ["m"],
		ioBudget: 32,
		deadlineAt: Date.now() + 5000,
	} as const;
	const params = { ...pg, messageIds: [...pg.messageIds] };
	const progress = ({ tableName }: { tableName: string }) => {
		if (tableName === "accepted") accepted.resolve();
	};
	const first = failureOf(
		runReadTask(unusedDb, params, { dedupeKey: "pg", signal: one.signal, onProgress: progress }),
	);
	const second = failureOf(
		runReadTask(unusedDb, params, { dedupeKey: "pg", signal: two.signal, onProgress: progress }),
	);
	await accepted.promise;
	one.abort();
	await first;
	expect(posted.filter((message) => message.type === "cancel")).toHaveLength(0);
	two.abort();
	await second; // HTTP subscription may finish before the underlying DB operation.
	// Use direct worker messages to observe ACK: cancelled subscribers no longer receive progress.
	const cancelMessage = new Promise<void>((resolve) =>
		handles[0]?.resource.on("message", (message) => {
			if (message.type === "progress" && message.tableName === "cancel") resolve();
		}),
	);
	await cancelMessage;
	const exitGate = deferred();
	const termination = deferred();
	const worker = handles[0]?.resource;
	if (!worker) throw new Error("Expected an owned worker");
	const terminate = worker.terminate.bind(worker);
	spyOn(worker, "terminate").mockImplementation(async () => {
		termination.resolve();
		await exitGate.promise;
		return terminate();
	});
	const queued = runReadTask(unusedDb, task);
	expect(getDbWorkerPoolStats()).toMatchObject({ busy: 1, queued: 1 });
	expect(handles).toHaveLength(1);
	worker.postMessage({ type: "ack" });
	await termination.promise;
	expect(handles).toHaveLength(1);
	expect(getDbWorkerPoolStats().queued).toBe(1);
	exitGate.resolve();
	const value = await queued;
	expect(value).toBe(42);
	expect(handles).toHaveLength(2);
	expect(typeof (await handles[0]?.exited)).toBe("number");
});

test("PG ACK watchdog forces actual termination before replacement", async () => {
	const accepted = deferred();
	fixture(`parentPort.on("message", data => {
		if(data.type === "task") parentPort.postMessage({type:"progress",requestId:data.requestId,tableName:"accepted",done:0,total:1});
	});`);
	const controller = new AbortController();
	const pending = failureOf(
		runReadTask(
			unusedDb,
			{
				kind: "displayPageMessagesPostgres",
				messageIds: ["m"],
				ioBudget: 32,
				deadlineAt: Date.now() + 5000,
			},
			{ signal: controller.signal, onProgress: () => accepted.resolve() },
		),
	);
	await accepted.promise;
	controller.abort();
	const error = await pending;
	expect((error as Error).message).toContain("aborted");
	expect(typeof (await handles[0]?.exited)).toBe("number");
	expect(getDbWorkerPoolStats().workers).toBe(0);
}, 5000);

test("shutdown disables admission before cancellation and waits for actual termination", async () => {
	fixture(success);
	expect(await runReadTask(unusedDb, task)).toBe(42);
	const gate = deferred();
	const stopping = deferred();
	const worker = handles[0]?.resource;
	if (!worker) throw new Error("Expected an owned worker");
	const terminate = worker.terminate.bind(worker);
	spyOn(worker, "terminate").mockImplementation(async () => {
		stopping.resolve();
		await gate.promise;
		return terminate();
	});
	let closed = false;
	const closing = shutdownDbWorkerPool({ permanent: true }).then(() => {
		closed = true;
	});
	await stopping.promise;
	expect(closed).toBe(false);
	expect(getDbWorkerPoolStats().workers).toBe(1);
	expect(await failureOf(runReadTask(unusedDb, task))).toMatchObject({ reason: "pool_shutdown" });
	expect(await failureOf(runEphemeralReadTask(unusedDb, task))).toMatchObject({
		reason: "pool_shutdown",
	});
	gate.resolve();
	await closing;
	expect(getDbWorkerPoolStats().workers).toBe(0);
	expect(await failureOf(runReadTask(unusedDb, task))).toMatchObject({ reason: "pool_shutdown" });
});

test("maintenance pause blocks both profiles until explicit resume", async () => {
	fixture(success);
	await shutdownDbWorkerPool({ pause: true });
	expect(await failureOf(runReadTask(unusedDb, task))).toMatchObject({ reason: "pool_shutdown" });
	expect(await failureOf(runEphemeralReadTask(unusedDb, task))).toMatchObject({
		reason: "pool_shutdown",
	});
	resumeDbWorkerPool();
	expect(await runReadTask(unusedDb, task)).toBe(42);
});

test.each([
	"dispatch",
	"messageerror",
	"error",
])("native %s retires the owner without replay", async (mode) => {
	const accepted = deferred();
	fixture(`parentPort.on("message", data => {
		if(data.type === "task") parentPort.postMessage({type:"progress",requestId:data.requestId,tableName:"accepted",done:0,total:1});
	});`);
	const pending = failureOf(runReadTask(unusedDb, task, { onProgress: () => accepted.resolve() }));
	await nextSpawn.promise;
	const worker = handles[0]?.resource;
	if (!worker) throw new Error("Expected an owned worker");
	if (mode === "dispatch") {
		const send = worker.postMessage.bind(worker);
		spyOn(worker, "postMessage").mockImplementation((message) => {
			if (message.type === "task") throw new Error("dispatch failed");
			send(message);
		});
	} else {
		await accepted.promise;
		worker.emit(mode, new Error("private native text"));
	}
	const error = await pending;
	expect(error).toBeInstanceOf(Error);
	expect(typeof (await handles[0]?.exited)).toBe("number");
	expect(getDbWorkerPoolStats()).toMatchObject({ workers: 0, starting: 0, claimed: 0, queued: 0 });
	expect(handles).toHaveLength(1);
	fixture(success);
	expect(await runReadTask(unusedDb, task)).toBe(42);
});

test("frozen readiness identity is validated before dispatch", async () => {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "../failure.ts")],
		target: "bun",
		define: { __NARRAFORK_RUNTIME_BUILD_ID__: JSON.stringify("frozen-build") },
	});
	expect(build.success).toBe(true);
	const modulePath = join(dir, "frozen-failure.mjs");
	await Bun.write(modulePath, build.outputs[0]);
	const frozen = await import(modulePath);
	const check = spyOn(failures, "assertWorkerBuildId").mockImplementation(
		frozen.assertWorkerBuildId,
	);
	restores.push(() => check.mockRestore());
	for (const buildId of [undefined, null, "stale", "frozen-build"]) {
		await resetDbWorkerPoolForTest();
		posted.length = 0;
		fixture(
			`${success}\nparentPort.postMessage(${JSON.stringify({ type: "ready", buildId })});`,
			false,
		);
		const value = await failureOf(runReadTask(unusedDb, task));
		if (buildId === "frozen-build") expect(value).toBe(42);
		else {
			expect(value).toMatchObject({ reason: "worker_spawn_failed" });
			expect(posted.filter((message) => message.type === "task")).toHaveLength(0);
		}
		expect(check).toHaveBeenCalledWith(buildId);
	}
});

test("source hot reload reuses the same runtime instead of creating parallel owners", async () => {
	fixture(success);
	expect(await runReadTask(unusedDb, task)).toBe(42);
	const s = Reflect.get(globalThis, Symbol.for("narrafork.dbWorkerPool"));
	const pool = s.pool;
	const reloaded = (await import(
		`../pool.ts?shared-runtime=${Date.now()}`
	)) as typeof import("../pool");
	expect(await reloaded.runReadTask(unusedDb, task)).toBe(42);
	expect(s.pool).toBe(pool);
	expect(handles).toHaveLength(1);
	await reloaded.shutdownDbWorkerPool();
	expect(await reloaded.runReadTask(unusedDb, task)).toBe(42);
	expect(handles).toHaveLength(2);
});

test("legacy HMR owners are observed through real exit before runtime startup", async () => {
	await shutdownDbWorkerPool();
	fixture(success);
	const current = Reflect.get(globalThis, Symbol.for("narrafork.dbWorkerPool"));
	const url = URL.createObjectURL(
		new Blob(["self.onmessage=()=>{};"], { type: "application/javascript" }),
	);
	const legacy = new globalThis.Worker(url);
	let exited = false;
	legacy.addEventListener("close", () => {
		exited = true;
	});
	const gate = deferred();
	const terminate = legacy.terminate.bind(legacy);
	spyOn(legacy, "terminate").mockImplementation((() => {
		void gate.promise.then(() => terminate());
	}) as typeof legacy.terminate);
	const old = {
		workers: [{ worker: legacy }],
		pending: new Map(),
		queue: [],
		inFlight: new Map(),
		spawnFailures: 0,
		disabledReason: null,
		testSpecifiers: current.testSpecifiers,
	};
	Reflect.set(globalThis, Symbol.for("narrafork.dbWorkerPool"), old);
	try {
		const reloaded = (await import(
			`../pool.ts?legacy-runtime=${Date.now()}`
		)) as typeof import("../pool");
		const pending = reloaded.runReadTask(unusedDb, task);
		await Promise.resolve();
		expect(handles).toHaveLength(0);
		expect(exited).toBe(false);
		gate.resolve();
		expect(await pending).toBe(42);
		expect(exited).toBe(true);
		expect(String(Reflect.get(old, "disabledReason"))).toBe("pool_shutdown"); // Stale pre-runtime closures stay disabled.
		expect(reloaded.getDbWorkerAvailability()).toEqual({ available: true, reason: null });
		await reloaded.shutdownDbWorkerPool();
	} finally {
		gate.resolve();
		Reflect.set(globalThis, Symbol.for("narrafork.dbWorkerPool"), current);
		URL.revokeObjectURL(url);
	}
});

test("failed startup cleanup is passed to shared resource accounting before public error mapping", async () => {
	fixture(hanging, false);
	const controller = new AbortController();
	const pending = failureOf(runReadTask(unusedDb, task, { signal: controller.signal }));
	await nextSpawn.promise;
	const handle = handles[0];
	if (!handle) throw new Error("Expected a startup owner");
	const close = handle.close.bind(handle);
	const closeCalled = deferred();
	const stop = spyOn(handle, "close").mockImplementation(() => {
		closeCalled.resolve();
		return Promise.reject(new Error("fixture stop failed"));
	});
	let queued: Promise<unknown> | undefined;
	try {
		controller.abort();
		await closeCalled.promise;
		fixture(success);
		queued = failureOf(runReadTask(unusedDb, task));
		await Bun.sleep(20); // Let the rejected factory unwind and the waiting borrow inspect its owner.
		expect(handles).toHaveLength(1);
		expect(getDbWorkerPoolStats().workers).toBe(1);
		expect(getDbWorkerPoolStats().spawnFailures).toBe(0);
	} finally {
		stop.mockRestore();
		await close();
	}
	expect(await pending).toMatchObject({ reason: "worker_cleanup_failed" });
	expect(await queued).toBe(42);
	expect(handles).toHaveLength(2);
});

test("reused readers take SQL trace parent from each run, never from the factory", async () => {
	fixture(success);
	const trace = spyOn(sqlTrace, "currentSqlTraceSpan");
	restores.push(() => trace.mockRestore());
	trace.mockReturnValue({ id: "first-parent" } as sqlTrace.SqlTraceSpan);
	expect(await runReadTask(unusedDb, task)).toBe(42);
	trace.mockReturnValue({ id: "second-parent" } as sqlTrace.SqlTraceSpan);
	expect(await runReadTask(unusedDb, task)).toBe(42);
	expect(handles).toHaveLength(1);
	expect(
		posted.filter((message) => message.type === "task").map((message) => message.traceParent),
	).toEqual(["first-parent", "second-parent"]);
});

test.each([false, true])("diagnostics omit driver text and every path (startup=%s)", (startup) => {
	const error = Object.assign(
		new TypeError("SELECT secret_prompt postgres://name:password@db/private"),
		{ code: "SQLITE_BUSY_SNAPSHOT", filename: "/private/worker.ts", lineno: 12, colno: 4 },
	);
	error.stack = `${error.message}\n${"    at read (/worker.ts:12:4)\n".repeat(10_000)}`;
	const details = failures.workerFailureDetails(error, startup);
	expect(details).toEqual({ errorType: "TypeError", code: "SQLITE_BUSY_SNAPSHOT" });
	expect(JSON.stringify(details)).not.toContain("secret_prompt");
	expect(JSON.stringify(details)).not.toContain("name:password");
	expect(JSON.stringify(details)).not.toContain("/worker.ts");
	expect(JSON.stringify(details)).not.toContain("/private");
	expect(Object.keys(details).sort()).toEqual(["code", "errorType"]);
});

test.each([
	false,
	true,
])("diagnostic categories reject arbitrary names and codes (startup=%s)", (startup) => {
	const secret = "PRIVATE_PROMPT_BODY";
	for (const error of [
		{ name: secret, code: `SQLITE_${secret}` },
		{ errorType: secret, code: `SQLITE_${secret}`, extra: { message: secret } },
		{ error: Object.assign(new Error(secret), { name: secret, code: `SQLITE_${secret}` }) },
		new Error(secret, {
			cause: Object.assign(new Error(secret), { name: secret, code: `SQLITE_${secret}` }),
		}),
		secret,
		null,
	]) {
		const details = failures.workerFailureDetails(error, startup);
		expect(details).toEqual({ errorType: "WorkerError", code: undefined });
		expect(JSON.stringify(details)).not.toContain(secret);
	}
	// Business error-code compatibility is separate from the narrower diagnostic allowlist.
	expect(failures.safeSqliteCode({ code: `SQLITE_${secret}` })).toBe(`SQLITE_${secret}`);
});

test.each([
	"SQLITE_BUSY",
	"SQLITE_LOCKED_SHAREDCACHE",
	"SQLITE_CONSTRAINT_UNIQUE",
	"DB_WORKER_BUILD_MISMATCH",
	"ERR_MODULE_NOT_FOUND",
	"TIMEOUT",
	"EXITED",
])("diagnostic projection retains the safe code %s across repeated boundaries", (code) => {
	const details = failures.workerFailureDetails(
		{ error: Object.assign(new SyntaxError("private module"), { code }) },
		true,
	);
	expect(details).toEqual({ errorType: "SyntaxError", code });
	expect(
		failures.workerFailureDetails(
			new Error("private entry path", {
				cause: Object.assign(new SyntaxError("private module"), { code }),
			}),
			true,
		),
	).toEqual(details);
	expect(failures.workerFailureDetails(details, false)).toEqual(details);
});

test("diagnostics never read payload fields or coerce an unknown failure", () => {
	const error = { name: "TypeError", code: "SQLITE_BUSY" };
	for (const key of ["message", "stack", "filename", "lineno", "colno", "toString"]) {
		Object.defineProperty(error, key, {
			get() {
				throw new Error(`Diagnostic must not read ${key}`);
			},
		});
	}
	expect(failures.workerFailureDetails(error, true)).toEqual({
		errorType: "TypeError",
		code: "SQLITE_BUSY",
	});
	expect(
		failures.workerFailureDetails(
			new Proxy(
				{},
				{
					get: () => {
						throw new Error("private getter");
					},
				},
			),
			false,
		),
	).toEqual({ errorType: "WorkerError", code: undefined });
});

test("synchronous creation failure is diagnosed without leaking credentials or paths", async () => {
	fixture(success);
	const spy = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		throw Object.assign(
			new TypeError(
				`Cannot resolve fixture module ${dir} postgres://alice:secret@host/db?token=abc password=private`,
			),
			{ code: "ERR_MODULE_NOT_FOUND", filename: `${dir}/entry.ts` },
		);
	});
	restores.push(() => spy.mockRestore());
	const error = await failureOf(runReadTask(unusedDb, task));
	expect(error).toMatchObject({ reason: "worker_spawn_failed" });
	expect(getDbWorkerPoolStats()).toMatchObject({ starting: 0, claimed: 0, spawnFailures: 1 });
	const calls = (logger.warn as ReturnType<typeof spyOn>).mock.calls;
	expect(calls).toEqual([
		[
			"Database read worker failure",
			{
				entry: "db-read-worker",
				phase: "ready",
				buildId: RUNTIME_BUILD_ID,
				errorType: "TypeError",
				code: "ERR_MODULE_NOT_FOUND",
			},
		],
	]);
	const logs = JSON.stringify(calls);
	expect(logs).not.toContain("Cannot resolve fixture module");
	expect(logs).not.toContain("alice:secret");
	expect(logs).not.toContain("password=private");
	expect(logs).not.toContain(dir);
	expect(logs).not.toContain(unusedDb);
});

test.each([
	{ errorType: "TypeError", code: "SQLITE_BUSY" },
	{ errorType: "PRIVATE_PROMPT_BODY", code: "SQLITE_PRIVATE_PROMPT_BODY" },
])("query failure logs re-project received diagnostics without changing business errors: %j", async (category) => {
	const message = "SELECT PRIVATE_PROMPT_BODY postgres://alice:secret@host/private";
	const code = "PRIVATE_BUSINESS_CODE";
	const diagnostic = {
		...category,
		message,
		stack: `Error: ${message}\n    at read (${dir}/entry.ts:12:4)`,
		filename: `${dir}/entry.ts`,
		file: `${dir}/private.sqlite`,
		entry: dir,
		phase: message,
		buildId: message,
		error: { message, path: dir },
	};
	fixture(`parentPort.on("message", data => {
		if (data.type === "task") parentPort.postMessage({
			type:"error", requestId:data.requestId,
			message:${JSON.stringify(message)}, code:${JSON.stringify(code)},
			diagnostic:${JSON.stringify(diagnostic)}
		});
	});`);
	const error = await failureOf(runReadTask(unusedDb, task));
	expect(error).toMatchObject({ name: "DbReadTaskExecutionError", message, code });
	const calls = (logger.warn as ReturnType<typeof spyOn>).mock.calls;
	expect(calls).toEqual([
		[
			"Database read worker query failed",
			{
				entry: "db-read-worker",
				phase: "read",
				buildId: RUNTIME_BUILD_ID,
				errorType: category.errorType === "TypeError" ? "TypeError" : "WorkerError",
				code: category.code === "SQLITE_BUSY" ? "SQLITE_BUSY" : undefined,
			},
		],
	]);
	const logs = JSON.stringify(calls);
	expect(logs).not.toContain("PRIVATE_PROMPT_BODY");
	expect(logs).not.toContain("alice:secret");
	expect(logs).not.toContain(code);
	expect(logs).not.toContain(dir);
	expect(logs).not.toContain(unusedDb);
});

test("real SQLite diagnostics omit query bodies and database paths while retaining task errors", async () => {
	const dbPath = join(dir, "PRIVATE_DB_BODY.sqlite");
	const db = new Database(dbPath, { create: true });
	db.run("CREATE TABLE fixture (value INTEGER)");
	db.close();
	setDbWorkerSpecifiersForTest(null);
	const error = await failureOf(
		runReadTask(dbPath, {
			kind: "selectRows",
			sql: "SELECT * FROM PRIVATE_QUERY_BODY",
			params: [],
			maxRows: 10,
		}),
	);
	expect(error).toMatchObject({ name: "DbReadTaskExecutionError", code: "SQLITE_ERROR" });
	expect((error as Error).message).toContain("PRIVATE_QUERY_BODY");
	expect(
		await runReadTask(dbPath, {
			kind: "selectRows",
			sql: "SELECT 42 AS value",
			params: [],
			maxRows: 10,
		}),
	).toEqual({ columns: ["value"], rows: [[42]] });
	expect(handles).toHaveLength(1);
	const calls = (logger.warn as ReturnType<typeof spyOn>).mock.calls;
	expect(calls).toEqual([
		[
			"Database read worker query failed",
			{
				entry: "db-read-worker",
				phase: "read",
				buildId: RUNTIME_BUILD_ID,
				errorType: "SQLiteError",
				code: "SQLITE_ERROR",
			},
		],
	]);
	const logs = JSON.stringify(calls);
	expect(logs).not.toContain("PRIVATE_QUERY_BODY");
	expect(logs).not.toContain("PRIVATE_DB_BODY");
	expect(logs).not.toContain(dbPath);
	expect(logs).not.toContain(dir);
});

test("runtime worker failures log a stable category without the thrown body or entry path", async () => {
	const message = `PRIVATE_RUNTIME_BODY postgres://alice:secret@host/db ${dir}`;
	fixture(`parentPort.on("message", data => {
		if (data.type === "task") throw new TypeError(${JSON.stringify(message)});
	});`);
	const error = await failureOf(runReadTask(unusedDb, task));
	expect(error).toMatchObject({
		name: "DbReadTaskExecutionError",
		message: "database worker died before completion",
	});
	const calls = (logger.warn as ReturnType<typeof spyOn>).mock.calls;
	expect(calls).toEqual([
		[
			"Database read worker failure",
			{
				entry: "db-read-worker",
				phase: "run",
				buildId: RUNTIME_BUILD_ID,
				errorType: "TypeError",
				code: undefined,
			},
		],
	]);
	const logs = JSON.stringify(calls);
	expect(logs).not.toContain("PRIVATE_RUNTIME_BODY");
	expect(logs).not.toContain("alice:secret");
	expect(logs).not.toContain(dir);
	expect(logs).not.toContain(unusedDb);
});
