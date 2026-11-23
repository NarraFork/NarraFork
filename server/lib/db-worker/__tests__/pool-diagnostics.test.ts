import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker as NodeWorker } from "node:worker_threads";
import { hotSafe } from "../../hot-safe";
import { logger } from "../../logger";
import { WorkerCleanupError, WorkerHandle } from "../../worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool } from "../../worker-runtime/pool";
import {
	DB_READ_QUEUE_MAX_BYTES,
	DB_READ_QUEUE_MAX_TASKS,
	DbReadTaskOverloadedError,
	getDbReadSchedulingPressure,
	getDbWorkerAvailability,
	getDbWorkerPoolStats,
	type RunReadTaskOptions,
	resetDbWorkerPoolForTest,
	resumeDbWorkerPool,
	runEphemeralReadTask,
	runReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../pool";
import type { DbReadTaskParams, DbWorkerInbound, DbWorkerOutbound } from "../protocol";
import {
	readPoolTaskLabels,
	type readPoolTaskSnapshot,
	warnReadPoolTaskTimeout,
	warnReadQueueFull,
} from "../read-diagnostics";

import type { SqlDiagnosticEvent } from "../sql-diagnostics";

type PostedTask = Extract<DbWorkerInbound, { type: "task" }>;
type Snapshot = ReturnType<typeof readPoolTaskSnapshot>;
type PressureRecord = Record<string, unknown> & {
	activeTasks: Snapshot[];
	queuedTasks: Snapshot[];
	incomingTask: Snapshot;
};
type ManualTimer = { callback: () => void; dueAt: number; cleared: boolean };
const secret = "https://private.invalid/database?token=nfs_private-token-hash";
const select = (): DbReadTaskParams => ({
	kind: "selectRows",
	sql: "SELECT ? AS private_sql_marker",
	params: [secret],
	maxRows: 1,
});
const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

let directory: string;
let databasePath: string;
let now: number;
let epoch = 1_800_000_000_000;
let previousConcurrency: string | undefined;
let previousWorker: string | undefined;
let previousSqlDiagnostics: string | undefined;
let spawn: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;
let originalSetTimeout: typeof setTimeout;
let originalClearTimeout: typeof clearTimeout;
let clock: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;
let workers: ControlledWorker[];
let timers: ManualTimer[];
let controllers: AbortController[];
let results: Promise<unknown>[];
let records: Array<{ message: string; fields: Record<string, unknown> }>;

/** Only scheduling/protocol are controlled; all admission, cancellation and cleanup are pool code. */
class ControlledWorker {
	private readonly events = new EventEmitter();
	readonly on = this.events.on.bind(this.events);
	readonly off = this.events.off.bind(this.events);
	readonly once = this.events.once.bind(this.events);
	current: PostedTask | undefined;
	readonly messages: DbWorkerInbound[] = [];
	terminated = false;
	deferExit = false;
	confirmExit(): void {
		this.events.emit("exit", 0);
	}
	constructor() {
		workers.push(this);
		queueMicrotask(() => this.emit({ type: "ready", buildId: null }));
	}
	emit(data: DbWorkerOutbound): void {
		this.events.emit("message", data);
	}
	postMessage(message: DbWorkerInbound): void {
		this.messages.push(message);
		if (message.type === "task") this.current = message;
	}
	finish(): void {
		if (!this.current) throw new Error("No controlled task to finish");
		const { requestId } = this.current;
		this.current = undefined;
		this.emit({
			type: "result",
			requestId,
			result: { columns: ["value"], rows: [[42]] },
			durationMs: 1,
		});
	}
	terminate(): void {
		if (this.terminated) return;
		this.terminated = true;
		this.current = undefined;
		if (!this.deferExit) this.confirmExit();
	}
}

async function flushUntil(condition: () => boolean): Promise<void> {
	for (let index = 0; index < 100; index++) {
		if (condition()) return;
		await Promise.resolve();
	}
	expect(condition()).toBe(true);
}
function start(params = select(), options: RunReadTaskOptions = {}) {
	const controller = new AbortController();
	controllers.push(controller);
	const result = failureOf(
		runReadTask(databasePath, params, { timeoutMs: 30_000, signal: controller.signal, ...options }),
	);
	results.push(result);
	return { controller, result };
}
async function fillActive(count: number, options: RunReadTaskOptions = {}) {
	for (let index = 0; index < count; index++) start(select(), options);
	await flushUntil(() => getDbWorkerPoolStats().busy === count);
}
async function fillQueue(count = (DB_READ_QUEUE_MAX_TASKS * 3) / 4) {
	const previous = getDbWorkerPoolStats().queued;
	for (let index = 0; index < count; index++) start();
	await flushUntil(() => getDbWorkerPoolStats().queued === previous + count);
}
async function reject() {
	const error = await start(select(), { diagnosticSource: secret }).result;
	expect(error).toBeInstanceOf(DbReadTaskOverloadedError);
	expect(error).toMatchObject({ code: "DB_READ_TASK_OVERLOADED" });
	return error;
}
function pressureRecords(): PressureRecord[] {
	return records
		.filter((record) => record.message === "Database read queue admission rejected")
		.map((record) => record.fields as PressureRecord);
}
function assertPrivatePayloadAbsent(value: unknown): void {
	const text = JSON.stringify(value);
	for (const privateText of [
		secret,
		"private_sql_marker",
		"private-kind",
		databasePath,
		directory,
		"diagnosticSource",
		"params",
		"stack",
		"entry",
	])
		expect(text).not.toContain(privateText);
}
function currentPoolState() {
	let value = Reflect.get(globalThis, Symbol.for("narrafork.dbWorkerPool"));
	while (value.replacement) value = value.replacement;
	return value;
}
function fireDueTimers(): void {
	for (const timer of [...timers]) {
		if (timer.cleared || timer.dueAt > now) continue;
		timer.cleared = true;
		timer.callback();
	}
}

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "nf-pool-diagnostics-"));
	databasePath = join(directory, "private.db");
	writeFileSync(databasePath, "Controlled workers never open this source");
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	previousWorker = process.env.NARRAFORK_DB_WORKER;
	previousSqlDiagnostics = process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
	delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "4";
	delete process.env.NARRAFORK_DB_WORKER;
	await resetDbWorkerPoolForTest();
	setDbWorkerSpecifiersForTest([join(directory, "private-worker-entry.ts")]);
	epoch += 100_000;
	now = epoch;
	workers = [];
	timers = [];
	controllers = [];
	results = [];
	records = [];
	originalSetTimeout = globalThis.setTimeout;
	originalClearTimeout = globalThis.clearTimeout;
	clock = spyOn(Date, "now").mockImplementation(() => now);
	warn = spyOn(logger, "warn").mockImplementation((message, fields) => {
		records.push({ message, fields: fields ?? {} });
	});
	spawn = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		const worker = new ControlledWorker();
		const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
		return new WorkerHandle(worker as unknown as NodeWorker, exited, () => worker.terminate());
	});
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay = 0,
		...args: unknown[]
	) => {
		const timer = { callback: () => callback(...args), dueAt: now + delay, cleared: false };
		timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout> | number | undefined) => {
		const timer = timers.find((entry) => entry === (handle as unknown));
		if (timer) timer.cleared = true;
		else originalClearTimeout(handle);
	}) as typeof clearTimeout;
});

afterEach(async () => {
	try {
		for (const controller of controllers) controller.abort();
		await shutdownDbWorkerPool();
		await Promise.all(results);
		expect(getDbWorkerPoolStats()).toMatchObject({
			busy: 0,
			queued: 0,
			queuedBytes: 0,
			tracked: 0,
		});
	} finally {
		spawn.mockRestore();
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		clock.mockRestore();
		warn.mockRestore();
		setDbWorkerSpecifiersForTest(null);
		if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
		if (previousSqlDiagnostics === undefined) delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
		else process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = previousSqlDiagnostics;
		if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previousWorker;
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("main read reservations and deadlines", () => {
	test("single-CPU default is two while an explicit single main slot is unavailable", async () => {
		const cpu = spyOn(os, "cpus").mockReturnValue([]);
		try {
			delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
			const reloaded = (await import(`../pool.ts?single-cpu=${now}`)) as typeof import("../pool");
			expect(reloaded.getConfiguredConcurrency()).toBe(2);
			process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
			expect(await start().result).toMatchObject({
				code: "DB_READ_UNAVAILABLE",
				reason: "concurrency_requires_at_least_2",
			});
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			cpu.mockRestore();
		}
	});
	test("ordinary saturation preserves a real worker for short reads and reports queued admission", async () => {
		expect(getDbReadSchedulingPressure()).toMatchObject({ available: true, shouldYield: false });
		expect(spawn).not.toHaveBeenCalled();
		await fillActive(3);
		expect(getDbReadSchedulingPressure()).toMatchObject({
			shouldYield: true,
			normalHeld: 3,
			normalCapacity: 3,
		});
		const ordinary = start(select(), { diagnosticSource: "auth.session" });
		await flushUntil(() => getDbWorkerPoolStats().queued === 1);
		const short = start(select(), { schedulingHint: "auth-session" });
		await flushUntil(() => workers.length === 4 && Boolean(workers[3].current));
		expect(getDbWorkerPoolStats()).toMatchObject({
			activeByClass: { normal: 3, short: 1 },
			queuedByClass: { normal: 1, short: 0 },
			reservation: { shared: { claimed: 3 }, reserved: { claimed: 1 } },
		});
		workers[3].finish();
		expect(await short.result).toEqual({ columns: ["value"], rows: [[42]] });
		expect(getDbWorkerPoolStats().queued).toBe(1);
		expect(ordinary.controller.signal.aborted).toBe(false);
	});
	test("short reads can occupy all N slots and healthy idle owners are reused", async () => {
		await fillActive(4, { schedulingHint: "auth-session" });
		expect(getDbReadSchedulingPressure()).toMatchObject({ shouldYield: true, normalHeld: 3 });
		for (const worker of workers) worker.finish();
		await Promise.all(results);
		const next = start(select(), { schedulingHint: "auth-session" });
		await flushUntil(() => workers.some((worker) => worker.current));
		workers.find((worker) => worker.current)?.finish();
		await next.result;
		expect(spawn).toHaveBeenCalledTimes(4);
	});
	test("classification is part of deduplication and invalid hints never spawn", async () => {
		for (const options of [{ schedulingHint: "unknown" }, { schedulingHint: null }])
			expect(await start(select(), options as RunReadTaskOptions).result).toMatchObject({
				code: "DB_READ_INVALID",
			});
		expect(
			await start({ kind: "storageScanContext" }, { schedulingHint: "auth-session" }).result,
		).toMatchObject({ code: "DB_READ_INVALID" });
		expect(await start({ kind: "invalid" } as unknown as DbReadTaskParams).result).toMatchObject({
			code: "DB_READ_INVALID",
		});
		expect(spawn).not.toHaveBeenCalled();
		start(select(), { dedupeKey: "same" });
		start(select(), { dedupeKey: "same", schedulingHint: "auth-session" });
		start(select(), { dedupeKey: "same", schedulingHint: "auth-session" });
		start({ kind: "domainRead", task: "readerProbe", input: null }, { dedupeKey: "same" });
		await flushUntil(() => getDbWorkerPoolStats().busy === 3);
		expect(getDbWorkerPoolStats().inFlight).toBe(3);
		expect(spawn).toHaveBeenCalledTimes(3);
	});
	test("subscriber deadlines expire independently and do not reset producer budget", async () => {
		const producer = start(select(), { dedupeKey: "deadline", deadlineAt: now + 100 });
		await flushUntil(() => Boolean(workers[0]?.current));
		now += 10;
		const early = start(select(), { dedupeKey: "deadline", deadlineAt: now + 20 });
		const late = start(select(), { dedupeKey: "deadline", deadlineAt: now + 500 });
		now += 20;
		fireDueTimers();
		expect(await early.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(workers[0].terminated).toBe(false);
		now += 70;
		fireDueTimers();
		expect(await producer.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(await late.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(spawn).toHaveBeenCalledTimes(1);
	});
	test("dedupe result delivery rechecks subscriber deadline before overdue timers run", async () => {
		const producer = start(select(), { dedupeKey: "late-delivery", deadlineAt: now + 1000 });
		await flushUntil(() => Boolean(workers[0]?.current));
		const subscriber = start(select(), { dedupeKey: "late-delivery", deadlineAt: now + 20 });
		now += 30;
		workers[0].finish();
		expect(await producer.result).toEqual({ columns: ["value"], rows: [[42]] });
		expect(await subscriber.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(workers[0].terminated).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(getDbWorkerPoolStats()).toMatchObject({ busy: 0, queued: 0, inFlight: 0 });
	});
	test("dedupe failure delivery keeps each subscriber deadline and the producer's original error", async () => {
		const producer = start(select(), { dedupeKey: "failed-delivery", deadlineAt: now + 1000 });
		await flushUntil(() => Boolean(workers[0]?.current));
		const subscriber = start(select(), { dedupeKey: "failed-delivery", deadlineAt: now + 20 });
		now += 30;
		workers[0].emit({
			type: "error",
			requestId: workers[0].current?.requestId ?? "",
			code: "DB_READ_FAILED",
			message: "controlled producer failure",
		});
		expect(await producer.result).toMatchObject({ code: "DB_READ_FAILED" });
		expect(await subscriber.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(spawn).toHaveBeenCalledTimes(1);
	});
	test("dedupe result delivery rechecks an aborted subscriber even without its abort callback", async () => {
		const producer = start(select(), { dedupeKey: "cancelled-delivery" });
		await flushUntil(() => Boolean(workers[0]?.current));
		const controller = new AbortController();
		controllers.push(controller);
		const add = spyOn(controller.signal, "addEventListener").mockImplementation(() => {});
		try {
			const subscriber = start(select(), {
				dedupeKey: "cancelled-delivery",
				signal: controller.signal,
			});
			controller.abort();
			workers[0].finish();
			expect(await producer.result).toEqual({ columns: ["value"], rows: [[42]] });
			expect(await subscriber.result).toMatchObject({ code: "DB_READ_ABORTED" });
			expect(workers[0].terminated).toBe(false);
			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			add.mockRestore();
		}
	});
	test.each([
		"connected",
		"cleanup-error",
	])("late legacy factory %s only touches its sealed lifecycle", async (mode) => {
		type FixtureOwner = {
			exited: Promise<unknown>;
			close(): Promise<void>;
			readonly closed: boolean;
			databaseIds: Set<string>;
		};
		type LegacyState = {
			runtimeVersion: number;
			upgrade?: Promise<void>;
			pool?: WorkerPool<void, void>;
			owners: Set<FixtureOwner>;
			requests: Map<string, unknown>;
		};
		const savedRoot = Reflect.get(globalThis, Symbol.for("narrafork.dbWorkerPool"));
		const entered = Promise.withResolvers<void>();
		const connection = Promise.withResolvers<PoolWorker<void, void> & FixtureOwner>();
		const native = new ControlledWorker();
		native.deferExit = true;
		const exited = new Promise<number>((resolve) => native.once("exit", resolve));
		const handle = new WorkerHandle(native as unknown as NodeWorker, exited, () =>
			native.terminate(),
		);
		const reader: PoolWorker<void, void> & FixtureOwner = {
			exited: handle.exited,
			databaseIds: new Set(),
			get closed() {
				return handle.closed;
			},
			async close() {
				await handle.close();
			},
			async run() {
				throw new Error("cancelled legacy factory dispatched");
			},
		};
		// The archived v2 proof exercises the full original module. These closures retain its
		// state guard and the two createReader -> trackOwner continuations as a permanent regression.
		const legacyState = (): LegacyState => {
			const value = hotSafe<LegacyState>("narrafork.dbWorkerPool", () => legacy);
			if (value.runtimeVersion !== 2) {
				value.runtimeVersion = 2;
				value.pool = undefined;
				value.requests = new Map();
				value.owners = new Set();
			}
			return value;
		};
		const legacyTrackOwner = (owner: FixtureOwner) => {
			const value = legacyState();
			value.owners.add(owner);
			void owner.exited.then(
				() => value.owners.delete(owner),
				() => {},
			);
		};
		const legacyPool = new WorkerPool<void, void>({
			concurrency: 1,
			create: async (context) => {
				await legacyState().upgrade;
				context.signal.throwIfAborted();
				entered.resolve();
				try {
					const owner = await connection.promise;
					legacyTrackOwner(owner);
					return owner;
				} catch (error) {
					if (error instanceof WorkerCleanupError)
						legacyTrackOwner({
							databaseIds: new Set(),
							exited: error.handle.exited,
							closed: true,
							async close() {
								await error.handle.exited;
							},
						});
					throw error;
				}
			},
		});
		const legacy = {
			runtimeVersion: 2,
			pool: legacyPool,
			owners: new Set<FixtureOwner>(),
			requests: new Map<string, unknown>(),
			inFlight: new Map(),
			requestCounter: 1,
			spawnFailures: 0,
			failureReason: null,
			testSpecifiers: [join(directory, "legacy-fixture.ts")],
			paused: false,
			permanent: false,
		};
		Reflect.set(globalThis, Symbol.for("narrafork.dbWorkerPool"), legacy);
		const oldResult = failureOf(legacyPool.run(undefined));
		results.push(oldResult);
		try {
			await entered.promise;
			const oldRequests = legacy.requests;
			if (mode === "connected") connection.resolve(reader);
			else
				connection.reject(
					new WorkerCleanupError(handle, new Error("controlled startup cleanup failure")),
				);
			getDbWorkerPoolStats();
			const replacement = Reflect.get(legacy, "replacement");
			await flushUntil(() => legacy.owners.size === 1);
			expect(legacy.runtimeVersion).toBe(2);
			expect(legacy.requests).toBe(oldRequests);
			expect(replacement.runtimeVersion).toBe(3);
			expect(replacement.owners.size).toBe(0);
			expect(replacement.pool).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
			expect(await start().result).toMatchObject({ reason: "pool_upgrading" });
			native.confirmExit();
			await oldResult;
			await replacement.upgrade;
			const admitted = start();
			await flushUntil(() => Boolean(workers[1]?.current));
			workers[1].finish();
			expect(await admitted.result).toEqual({ columns: ["value"], rows: [[42]] });
		} finally {
			native.confirmExit();
			await oldResult;
			await legacyPool.close().catch(() => {});
			await shutdownDbWorkerPool();
			Reflect.set(globalThis, Symbol.for("narrafork.dbWorkerPool"), savedRoot);
		}
	});
	test.each([
		1, 2,
	])("runtimeVersion %i upgrade waits for the previous owner's real exit", async (version) => {
		const first = start();
		await flushUntil(() => Boolean(workers[0]?.current));
		workers[0].finish();
		await first.result;
		const previousOwner = workers[0];
		previousOwner.deferExit = true;
		const state = currentPoolState();
		state.runtimeVersion = version;
		const reloaded = (await import(
			`../pool.ts?reservation-upgrade=${version}-${now}`
		)) as typeof import("../pool");
		const next = failureOf(reloaded.runReadTask(databasePath, select()));
		results.push(next);
		try {
			await flushUntil(() => previousOwner.terminated);
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(state.runtimeVersion).toBe(version);
			expect(state.replacement.runtimeVersion).toBe(3);
			expect(state.replacement.pool).toBeUndefined();
			const retiredBarrier = state.upgrade;
			state.upgrade = undefined;
			state.closing = undefined;
			expect(state.upgrade).toBe(retiredBarrier);
			expect(state.closing).toBe(retiredBarrier);
			expect(await retiredBarrier.catch((error: unknown) => error)).toMatchObject({
				reason: "pool_runtime_replaced",
			});
			expect(state.paused).toBe(true);
			expect(state.permanent).toBe(true);
			expect(await next).toMatchObject({ reason: "pool_upgrading" });
			previousOwner.confirmExit();
			await state.replacement.upgrade;
			const admitted = reloaded.runReadTask(databasePath, select());
			await flushUntil(() => Boolean(workers[1]?.current));
			workers[1].finish();
			expect(await admitted).toEqual({ columns: ["value"], rows: [[42]] });
		} finally {
			previousOwner.confirmExit();
		}
	});
	test("an existing maintenance pause stays closed until explicit current-generation recovery", async () => {
		const first = start();
		await flushUntil(() => Boolean(workers[0]?.current));
		workers[0].finish();
		await first.result;
		const legacy = currentPoolState();
		legacy.paused = true;
		legacy.runtimeVersion = 2;
		getDbWorkerPoolStats();
		await legacy.replacement.upgrade;
		expect(getDbWorkerAvailability()).toMatchObject({ available: false, reason: "pool_shutdown" });
		expect(await start().result).toMatchObject({ reason: "pool_shutdown" });
		expect(legacy.permanent).toBe(true);
		expect(legacy.replacement.permanent).toBe(false);
		resumeDbWorkerPool();
		const next = start();
		await flushUntil(() => Boolean(workers[1]?.current));
		workers[1].finish();
		expect(await next.result).toEqual({ columns: ["value"], rows: [[42]] });
	});
	test("failed legacy shared-pool close keeps new startup blocked", async () => {
		const first = start();
		await flushUntil(() => Boolean(workers[0]?.current));
		workers[0].finish();
		await first.result;
		const state = currentPoolState();
		const oldPool = state.pool;
		const close = oldPool.close.bind(oldPool);
		const failure = new Error("fixture old owner exit unconfirmed");
		const retire = spyOn(oldPool, "close").mockRejectedValue(failure);
		state.runtimeVersion = 2;
		const reloaded = (await import(
			`../pool.ts?reservation-failed-upgrade=${now}`
		)) as typeof import("../pool");
		try {
			expect(await failureOf(reloaded.runReadTask(databasePath, select()))).toMatchObject({
				reason: "pool_upgrading",
			});
			await flushUntil(() => state.replacement.failureReason === "pool_upgrade_failed");
			expect(await failureOf(reloaded.runReadTask(databasePath, select()))).toMatchObject({
				reason: "pool_upgrade_failed",
			});
			expect(getDbReadSchedulingPressure()).toMatchObject({
				available: false,
				shouldYield: false,
				reason: "pool_upgrade_failed",
			});
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(state.replacement.upgrade).toBeDefined();
		} finally {
			retire.mockRestore();
			await close();
			state.replacement.upgrade = undefined;
		}
	});
	test.each([
		64, 128,
	])("Q=%i enforces normal and global count boundaries independently", async (maxQueued) => {
		const previous = process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
		try {
			process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
			process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = String(maxQueued);
			await fillActive(1);
			start(select(), { schedulingHint: "auth-session" });
			await flushUntil(() => getDbWorkerPoolStats().busy === 2);
			await fillQueue((maxQueued * 3) / 4);
			expect(await start().result).toMatchObject({
				code: "DB_READ_TASK_OVERLOADED",
				reason: "normal-count",
			});
			for (let i = 0; i < maxQueued / 4; i++) start(select(), { schedulingHint: "auth-session" });
			await flushUntil(() => getDbWorkerPoolStats().queued === maxQueued);
			expect(await start(select(), { schedulingHint: "auth-session" }).result).toMatchObject({
				code: "DB_READ_TASK_OVERLOADED",
				reason: "total-count",
			});
			expect(getDbWorkerPoolStats().main).toMatchObject({
				maxQueued,
				queuedByClass: { normal: (maxQueued * 3) / 4, short: maxQueued / 4 },
			});
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
			else process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = previous;
		}
	});
	test("normal 6 MiB and total 8 MiB waiting bytes are independent inclusive limits", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		await fillActive(1);
		start(select(), { schedulingHint: "auth-session" });
		await flushUntil(() => getDbWorkerPoolStats().busy === 2);
		const normalParams = { kind: "storageScanTables", tableNames: [""] } as const;
		const probe = start({ ...normalParams, tableNames: [""] });
		const normalOverhead = getDbWorkerPoolStats().queuedBytes;
		probe.controller.abort();
		await probe.result;
		start({ ...normalParams, tableNames: ["x".repeat(6 * 1024 * 1024 - normalOverhead)] });
		expect(getDbWorkerPoolStats().queuedBytes).toBe(6 * 1024 * 1024);
		expect(await start().result).toMatchObject({
			code: "DB_READ_OVERLOADED",
			reason: "normal-bytes",
		});
		const shortProbe = start(
			{ kind: "selectRows", sql: "SELECT ?", params: [""], maxRows: 1 },
			{ schedulingHint: "auth-session" },
		);
		const shortOverhead = getDbWorkerPoolStats().queuedBytes - 6 * 1024 * 1024;
		shortProbe.controller.abort();
		await shortProbe.result;
		start(
			{
				kind: "selectRows",
				sql: "SELECT ?",
				params: ["x".repeat(2 * 1024 * 1024 - shortOverhead)],
				maxRows: 1,
			},
			{ schedulingHint: "auth-session" },
		);
		expect(getDbWorkerPoolStats().queuedBytes).toBe(8 * 1024 * 1024);
		expect(await start(select(), { schedulingHint: "auth-session" }).result).toMatchObject({
			code: "DB_READ_OVERLOADED",
			reason: "total-bytes",
		});
	});
	test("expired absolute deadlines do not dispatch or subscribe", async () => {
		expect(await start(select(), { deadlineAt: now }).result).toMatchObject({
			code: "DB_READ_TASK_TIMEOUT",
		});
		expect(spawn).not.toHaveBeenCalled();
	});
	test("main configuration stays frozen until the pool is closed", async () => {
		const previous = process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
		try {
			process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = "5";
			await fillActive(3);
			process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
			process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = "invalid";
			await fillQueue(3);
			expect(getDbWorkerAvailability()).toEqual({ available: true, reason: null });
			expect(getDbWorkerPoolStats()).toMatchObject({
				concurrency: 4,
				configuration: { maxQueued: 5, normalMaxQueued: 3 },
			});
			expect(await start().result).toMatchObject({
				code: "DB_READ_TASK_OVERLOADED",
				reason: "normal-count",
			});
			for (const controller of controllers) controller.abort();
			await Promise.all(results);
			await resetDbWorkerPoolForTest();
			expect(getDbWorkerAvailability().reason).toContain("at_least_2");
			process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
			expect(getDbWorkerAvailability().reason).toContain("invalid_max_queued");
			expect(getDbReadSchedulingPressure()).toMatchObject({ available: false, shouldYield: false });
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
			else process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = previous;
		}
	});
	test.each([
		0, 1,
	])("Q=%i preserves immediate execution and short waiting reservation", async (maxQueued) => {
		const previous = process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
		try {
			process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
			process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = String(maxQueued);
			await fillActive(1);
			expect(await start().result).toMatchObject({ code: "DB_READ_TASK_OVERLOADED" });
			start(select(), { schedulingHint: "auth-session" });
			await flushUntil(() => getDbWorkerPoolStats().busy === 2);
			const waiting = start(select(), { schedulingHint: "auth-session" });
			if (maxQueued === 0)
				expect(await waiting.result).toMatchObject({ code: "DB_READ_TASK_OVERLOADED" });
			else {
				await flushUntil(() => getDbWorkerPoolStats().queued === 1);
				expect(getDbWorkerPoolStats().queuedByClass).toEqual({ normal: 0, short: 1 });
			}
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
			else process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = previous;
		}
	});
	test("disabled compatibility reads retain a single worker and their own 32-entry queue", async () => {
		const previous = process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
		try {
			process.env.NARRAFORK_DB_WORKER = "off";
			process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
			process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = "invalid";
			const controller = new AbortController();
			controllers.push(controller);
			for (let index = 0; index < 33; index++)
				results.push(
					failureOf(runEphemeralReadTask(databasePath, select(), { signal: controller.signal })),
				);
			await flushUntil(() => getDbWorkerPoolStats().queued === 32);
			expect(getDbWorkerPoolStats()).toMatchObject({
				configuration: null,
				ephemeral: { concurrency: 1, maxQueued: 32 },
			});
			expect(await failureOf(runEphemeralReadTask(databasePath, select()))).toMatchObject({
				code: "DB_READ_TASK_OVERLOADED",
			});
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
			else process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = previous;
		}
	});
});

describe("bounded pool pressure diagnostics", () => {
	test("4 active + 48 queued snapshots keep fixed sources and ages without query payloads", async () => {
		start(select(), { diagnosticSource: "auth.session" });
		start(select(), { diagnosticSource: secret });
		start({ kind: "domainRead", task: "readerProbe", input: null });
		start(select());
		await flushUntil(() => getDbWorkerPoolStats().busy === 4);
		now += 20;
		for (let index = 0; index < (DB_READ_QUEUE_MAX_TASKS * 3) / 4; index++)
			start(select(), { diagnosticSource: index % 2 === 0 ? "auth.session" : secret });
		await flushUntil(() => getDbWorkerPoolStats().queued === 48);
		now += 5;
		const before = getDbWorkerPoolStats();
		if (!before.main) throw new Error("Expected an instantiated main pool");
		await reject();
		expect(getDbWorkerPoolStats()).toEqual({
			...before,
			main: { ...before.main, failed: before.main.failed + 1 },
		});
		const [record] = pressureRecords();
		expect(record).toMatchObject({
			workers: 4,
			busy: 4,
			concurrency: 4,
			queued: 48,
			maxQueued: 64,
			normalMaxQueued: 48,
			reason: "normal-count",
			maxQueuedBytes: 8 * 1024 * 1024,
			activeTotal: 4,
			activeMaxEntries: 4,
			activeTruncated: false,
			queuedMaxEntries: 32,
			queuedTruncated: true,
		});
		expect(record.activeTasks).toHaveLength(4);
		expect(record.queuedTasks).toHaveLength(32);
		expect(record.activeTasks.map((task) => task.source)).toEqual([
			"auth.session",
			"unattributed",
			"unattributed",
			"unattributed",
		]);
		expect(record.activeTasks[2]).toMatchObject({ kind: "domainRead", domainTask: "readerProbe" });
		expect(record.activeTasks[3]).toMatchObject({ kind: "selectRows", taskClass: "normal" });
		for (const task of record.activeTasks) expect(task.ageMs).toBe(25);
		for (const [index, task] of record.queuedTasks.entries()) {
			expect(task).toMatchObject({
				kind: "selectRows",
				source: index % 2 === 0 ? "auth.session" : "unattributed",
				ageMs: 5,
			});
		}
		const ids = [...record.activeTasks, ...record.queuedTasks, record.incomingTask].map((task) => {
			expect(task.requestId).toMatch(/^dbr-[a-z0-9]+-[a-z0-9]+$/);
			return task.requestId;
		});
		expect(new Set(ids).size).toBe(37);
		for (const worker of workers) {
			expect(worker.current).not.toHaveProperty("poolDiagnostic");
			expect(worker.current).not.toHaveProperty("diagnosticSource");
		}
		assertPrivatePayloadAbsent(records);
	});

	test("active log hard cap, rate limiting and suppression preserve pool budgets", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "16";
		await fillActive(12);
		await fillQueue();
		const before = getDbWorkerPoolStats();
		if (!before.main) throw new Error("Expected an instantiated main pool");
		for (let index = 0; index < 8; index++) await reject();
		expect(pressureRecords()).toHaveLength(5);
		for (const record of pressureRecords()) {
			expect(record).toMatchObject({ activeTotal: 12, activeMaxEntries: 8, activeTruncated: true });
			expect(record.activeTasks).toHaveLength(8);
			expect(record.queuedTasks).toHaveLength(32);
		}
		now += 10_000;
		await reject();
		expect(pressureRecords()).toHaveLength(6);
		expect(pressureRecords().at(-1)).toMatchObject({ suppressedSinceLastLog: 3 });
		expect(getDbWorkerPoolStats()).toEqual({
			...before,
			main: { ...before.main, failed: before.main.failed + 9 },
		});
		assertPrivatePayloadAbsent(records);
	});

	test("cancelled and completed tasks disappear; queued sources and IDs survive promotion", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const owner = start();
		await flushUntil(() => getDbWorkerPoolStats().busy === 1);
		const promoted = start(select(), { diagnosticSource: "auth.session" });
		const cancelled = start(select(), { diagnosticSource: secret });
		await flushUntil(() => getDbWorkerPoolStats().queued === 2);
		await fillQueue(46);
		await reject();
		const first = pressureRecords()[0];
		const ownerId = first.activeTasks[0].requestId;
		const promotedId = first.queuedTasks[0].requestId;
		const cancelledId = first.queuedTasks[1].requestId;
		const queuedBytes = getDbWorkerPoolStats().queuedBytes;
		cancelled.controller.abort();
		expect(await cancelled.result).toMatchObject({ code: "DB_READ_ABORTED" });
		expect(getDbWorkerPoolStats().queued).toBe(47);
		expect(getDbWorkerPoolStats().queuedBytes).toBeLessThan(queuedBytes);
		now += 50;
		workers[0].finish();
		await owner.result;
		await flushUntil(() => workers[0].current?.requestId === promotedId);
		await fillQueue(2);
		now += 7;
		await reject();
		const second = pressureRecords()[1];
		expect(second.activeTasks).toEqual([
			{
				requestId: promotedId,
				source: "auth.session",
				kind: "selectRows",
				taskClass: "normal",
				queueReason: "capacity",
				ageMs: 7,
			},
		]);
		const activeAndQueue = JSON.stringify([second.activeTasks, second.queuedTasks]);
		for (const removed of [ownerId, cancelledId]) expect(activeAndQueue).not.toContain(removed);
		expect(second.queuedTasks.map((task) => task.requestId)).not.toContain(promotedId);
		workers[0].finish();
		await promoted.result;
		for (let index = 0; index < 48; index++) {
			await flushUntil(() => Boolean(workers[0].current));
			workers[0].finish();
		}
		await Promise.all(results);
		expect(getDbWorkerPoolStats()).toMatchObject({
			busy: 0,
			queued: 0,
			queuedBytes: 0,
			inFlight: 0,
		});
	});

	test("queue and running timeouts correlate after an overload burst using a separate log budget", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const owner = start(select(), { diagnosticSource: "auth.session", timeoutMs: 100 });
		await flushUntil(() => getDbWorkerPoolStats().busy === 1);
		const queued = start(select(), { diagnosticSource: secret, timeoutMs: 50 });
		await flushUntil(() => getDbWorkerPoolStats().queued === 1);
		await fillQueue(47);
		for (let index = 0; index < 8; index++) await reject();
		const snapshot = pressureRecords()[0];
		now += 50;
		fireDueTimers();
		expect(await queued.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		now += 50;
		fireDueTimers();
		expect(await owner.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		const timeouts = records
			.filter((record) => record.message === "Database read task timed out")
			.map((record) => record.fields);
		expect(timeouts).toHaveLength(2);
		expect(timeouts[0]).toMatchObject({
			requestId: snapshot.queuedTasks[0].requestId,
			kind: "selectRows",
			source: "unattributed",
			phase: "queued",
			ageMs: 50,
			queuedAgeMs: 50,
			runningAgeMs: null,
		});
		expect(timeouts[1]).toMatchObject({
			requestId: snapshot.activeTasks[0].requestId,
			kind: "selectRows",
			source: "auth.session",
			phase: "running",
			ageMs: 100,
			runningAgeMs: 100,
		});
		assertPrivatePayloadAbsent(records);
	});

	test("logger and metadata failures preserve admission, timeout, cancellation and completion", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const options = {
			timeoutMs: 10,
			get diagnosticSource(): string {
				throw new Error(secret);
			},
		};
		// Pass getters directly, so the pool, rather than object spread in the fixture, reads them.
		const owner = failureOf(runReadTask(databasePath, select(), options));
		results.push(owner);
		await flushUntil(() => getDbWorkerPoolStats().busy === 1);
		await fillQueue();
		warn.mockImplementation(() => {
			throw new Error("diagnostic sink unavailable");
		});
		await reject();
		now += 10;
		fireDueTimers();
		expect(await owner).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		for (const controller of controllers) controller.abort();
		await Promise.all(results);
		const completed = runReadTask(databasePath, select(), options);
		await flushUntil(() => workers.some((worker) => !worker.terminated && worker.current));
		workers.find((worker) => !worker.terminated && worker.current)?.finish();
		expect(await completed).toEqual({ columns: ["value"], rows: [[42]] });
		expect(getDbWorkerPoolStats()).toMatchObject({ busy: 0, queued: 0, queuedBytes: 0 });
	});

	test("timeout evidence has a finite rate limit and reports suppressed records in the next window", () => {
		const task = {
			...readPoolTaskLabels({ kind: "selectRows" }, { diagnosticSource: "auth.session" }),
			requestId: "dbr-timeout-1",
			startedAt: now - 100,
			dispatchedAt: now - 80,
		};
		for (let index = 0; index < 8; index++) warnReadPoolTaskTimeout(task, "running");
		expect(records).toHaveLength(5);
		expect(records[0].fields).toMatchObject({ ageMs: 100, runningAgeMs: 80 });
		now += 10_000;
		warnReadPoolTaskTimeout(task, "running");
		expect(records).toHaveLength(6);
		expect(records.at(-1)?.fields).toMatchObject({ suppressedSinceLastLog: 3 });
	});

	test("only fixed kind/source/domain labels are retained and snapshot preparation is rate limited", () => {
		for (const source of [secret, "auth.session/extra", "constructor", "toString"])
			expect(readPoolTaskLabels({ kind: "selectRows" }, { diagnosticSource: source })).toEqual({
				kind: "selectRows",
				source: "unattributed",
			});
		for (const kind of [secret, "constructor", "toString"])
			expect(readPoolTaskLabels({ kind })).toEqual({
				kind: "unattributed",
				source: "unattributed",
			});
		for (const task of [secret, "constructor", "toString"])
			expect(readPoolTaskLabels({ kind: "domainRead", task })).toEqual({
				kind: "domainRead",
				source: "unattributed",
			});
		expect(readPoolTaskLabels({ kind: "domainRead", task: "readerProbe" })).toMatchObject({
			domainTask: "readerProbe",
		});
		let kindReads = 0;
		let domainReads = 0;
		expect(
			readPoolTaskLabels({
				get kind() {
					return ++kindReads === 1 ? "domainRead" : secret;
				},
				get task() {
					return ++domainReads === 1 ? "readerProbe" : secret;
				},
			}),
		).toEqual({ kind: "domainRead", domainTask: "readerProbe", source: "unattributed" });
		expect(kindReads).toBe(1);
		expect(domainReads).toBe(1);
		let prepared = 0;
		for (let index = 0; index < 8; index++)
			warnReadQueueFull(
				{
					reason: "count",
					taskKind: "selectRows",
					queued: 32,
					queuedBytes: 123,
					incomingBytes: 10,
					maxQueued: DB_READ_QUEUE_MAX_TASKS,
					maxQueuedBytes: DB_READ_QUEUE_MAX_BYTES,
					workers: 4,
					busy: 4,
					retiring: 0,
					pendingSpawns: 0,
					concurrency: 4,
				},
				() => {
					prepared++;
					throw new Error("snapshot unavailable");
				},
			);
		expect(prepared).toBe(5);
		expect(records).toHaveLength(0);
	});
});

function sqlEvent(
	worker: ControlledWorker,
	sequence = 1,
	id = 1,
): Extract<SqlDiagnosticEvent, { phase: "start" }> {
	const task = worker.current;
	if (!task) throw new Error("Expected current task");
	return {
		type: "sqlDiagnostic",
		requestId: task.requestId,
		session: task.sqlDiagnostic?.session ?? "1234567890abcdef",
		sequence,
		phase: "start",
		statement: {
			id,
			stage: "execute",
			operation: "get",
			hashStatus: "collected",
			sqlHash: "a".repeat(64),
			workerSite: { file: "server/lib/db-worker/select-rows.ts", line: 71, column: 4 },
		},
	};
}
function sqlRecords() {
	return records.filter((record) => record.message === "Database read worker SQL diagnostic");
}

describe("opt-in host SQL correlation", () => {
	test("disabled mode adds neither configuration nor logs; diagnostic messages cannot settle tasks", async () => {
		const pending = start();
		await flushUntil(() => Boolean(workers[0]?.current));
		expect(workers[0].current).not.toHaveProperty("sqlDiagnostic");
		workers[0].emit(sqlEvent(workers[0]));
		expect(getDbWorkerPoolStats().busy).toBe(1);
		expect(sqlRecords()).toHaveLength(0);
		workers[0].finish();
		expect(await pending.result).toEqual({ columns: ["value"], rows: [[42]] });
	});

	test("running SQL arrives before result and queue snapshots correlate safe host/worker labels", async () => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const pending = start(select(), { diagnosticSource: "auth.session" });
		await flushUntil(() => Boolean(workers[0]?.current));
		const current = workers[0].current;
		expect(current?.sqlDiagnostic?.key).toMatch(/^[a-f0-9]{64}$/);
		workers[0].emit(sqlEvent(workers[0]));
		expect(getDbWorkerPoolStats().busy).toBe(1);
		now += 31;
		await fillQueue();
		await reject();
		const pressure = pressureRecords()[0];
		expect(pressure.activeTasks[0]).toMatchObject({
			source: "auth.session",
			sql: {
				state: "running",
				worker: expect.stringMatching(/^dbw-\d+$/),
				current: { sqlHash: "a".repeat(64), operation: "get", ageMs: 31 },
			},
		});
		const diagnostic = pressure.activeTasks[0].sql;
		expect(diagnostic?.hostSite?.file).toBe(
			"server/lib/db-worker/__tests__/pool-diagnostics.test.ts",
		);
		for (const queued of pressure.queuedTasks) {
			expect(queued.sql).toMatchObject({ state: "unobserved" });
			expect(queued.sql?.current).toBeUndefined();
			expect(queued.sql?.worker).toBeUndefined();
		}
		const output = JSON.stringify(records);
		for (const privateText of [
			secret,
			"private_sql_marker",
			databasePath,
			directory,
			current?.sqlDiagnostic?.key,
		])
			if (privateText) expect(output).not.toContain(privateText);
		workers[0].finish();
		expect(await pending.result).toEqual({ columns: ["value"], rows: [[42]] });
	});

	test("stale requests are ignored; current malicious metadata and missing events become unknown", async () => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const first = start();
		await flushUntil(() => Boolean(workers[0]?.current));
		const stale = sqlEvent(workers[0]);
		workers[0].finish();
		await first.result;
		start();
		await flushUntil(() => Boolean(workers[0]?.current));
		const worker = workers[0];
		const before = sqlRecords().length;
		worker.emit(stale);
		expect(sqlRecords()).toHaveLength(before);
		worker.emit(sqlEvent(worker));
		worker.emit({ ...sqlEvent(worker, 3, 2), sql: secret } as unknown as SqlDiagnosticEvent);
		await fillQueue();
		await reject();
		expect(pressureRecords()[0].activeTasks[0].sql).toMatchObject({
			state: "unknown",
			reason: "invalid-event",
		});
		expect(pressureRecords()[0].activeTasks[0].sql?.current).toBeUndefined();
		expect(JSON.stringify(records)).not.toContain(secret);
		expect(getDbWorkerPoolStats().busy).toBe(1);
	});

	test("host log cap is 20 per window and queue/timeout evidence has independent budgets", async () => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const pending = start(select(), { timeoutMs: 100 });
		await flushUntil(() => Boolean(workers[0]?.current));
		let sequence = 0;
		for (let id = 1; id <= 50; id++) {
			const event = sqlEvent(workers[0], ++sequence, id);
			workers[0].emit(event);
			workers[0].emit({
				...event,
				sequence: ++sequence,
				phase: "end",
				durationMs: 1,
				outcome: "returned",
			});
		}
		expect(sqlRecords()).toHaveLength(20);
		const blocked = sqlEvent(workers[0], ++sequence, 51);
		blocked.statement.sqlHash = "b".repeat(64);
		workers[0].emit(blocked);
		await fillQueue();
		await reject();
		expect(pressureRecords()).toHaveLength(1);
		expect(pressureRecords()[0].activeTasks[0].sql).toMatchObject({
			state: "running",
			current: { sqlHash: "b".repeat(64), id: 51 },
		});
		expect(pressureRecords()[0].activeTasks[0].sql?.logSuppressed).toBeGreaterThan(0);
		now += 100;
		fireDueTimers();
		expect(await pending.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(
			records.filter((record) => record.message === "Database read task timed out"),
		).toHaveLength(1);
		expect(
			records.find((record) => record.message === "Database read task timed out")?.fields,
		).toMatchObject({
			sql: { state: "settled", lastObserved: { sqlHash: "b".repeat(64), id: 51 } },
		});
		expect(sqlRecords()).toHaveLength(20);
		await flushUntil(() => workers.some((worker) => !worker.terminated && worker.current));
		now += 10_000;
		const promoted = workers.find(
			(worker) => !worker.terminated && worker.current,
		) as ControlledWorker;
		promoted.emit(sqlEvent(promoted));
		expect(sqlRecords().at(-1)?.fields.suppressedSinceLastLog).toBeGreaterThan(0);
	});

	test("timeout retains last observed SQL; shared loss alone clears queue/timeout current hashes", async () => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const pending = start(select(), { diagnosticSource: "auth.session", timeoutMs: 100 });
		await flushUntil(() => Boolean(workers[0]?.current));
		workers[0].emit(sqlEvent(workers[0]));
		now += 100;
		fireDueTimers();
		expect(await pending.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		const timeout = records.find((record) => record.message === "Database read task timed out");
		expect(timeout?.fields).toMatchObject({
			source: "auth.session",
			sql: {
				state: "settled",
				taskOutcome: "failed",
				lastObserved: { sqlHash: "a".repeat(64), ageMs: 100 },
			},
		});
		const next = start(select(), { timeoutMs: 50 });
		await flushUntil(() => workers.some((worker) => !worker.terminated && worker.current));
		const worker = workers.find((entry) => !entry.terminated && entry.current) as ControlledWorker;
		worker.emit(sqlEvent(worker));
		const continuity = worker.current?.sqlDiagnostic?.continuity;
		expect(continuity).toBeInstanceOf(SharedArrayBuffer);
		expect(continuity?.byteLength).toBe(4);
		Atomics.store(new Int32Array(continuity as SharedArrayBuffer), 0, 1);
		await fillQueue();
		await reject();
		expect(pressureRecords()[0].activeTasks[0].sql).toMatchObject({
			state: "unknown",
			reason: "rate-limit",
		});
		expect(pressureRecords()[0].activeTasks[0].sql?.current).toBeUndefined();
		now += 50;
		fireDueTimers();
		expect(await next.result).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		const nextTimeout = records
			.filter((record) => record.message === "Database read task timed out")
			.at(-1);
		expect(nextTimeout?.fields).toMatchObject({ sql: { state: "unknown", reason: "rate-limit" } });
		expect((nextTimeout?.fields.sql as { current?: unknown }).current).toBeUndefined();
	});

	test("throwing diagnostic logger preserves chunk ACK and final result delivery", async () => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		let chunks = 0;
		const pending = start(
			{ kind: "selectChunks", sql: "SELECT 1", params: [], maxRows: 1 },
			{
				onChunk: () => {
					chunks++;
				},
			},
		);
		await flushUntil(() => Boolean(workers[0]?.current));
		warn.mockImplementation(() => {
			throw new Error(secret);
		});
		const worker = workers[0];
		worker.emit(sqlEvent(worker));
		expect(worker.messages.filter((message) => message.type === "chunkAck")).toHaveLength(0);
		worker.emit({
			type: "chunk",
			requestId: worker.current?.requestId ?? "",
			chunk: { sequence: 0, columns: ["n"], rows: [[1]] },
		});
		fireDueTimers();
		await flushUntil(() => worker.messages.some((message) => message.type === "chunkAck"));
		expect(worker.messages.filter((message) => message.type === "chunkAck")).toHaveLength(1);
		expect(chunks).toBe(1);
		worker.finish();
		expect(await pending.result).toEqual({ columns: ["value"], rows: [[42]] });
	});

	test("PostgreSQL retains task evidence with explicit uncovered status", async () => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		const pending = start({ kind: "displayPageMessagesPostgres" } as DbReadTaskParams);
		await flushUntil(() => Boolean(workers[0]?.current));
		expect(sqlRecords()[0].fields).toMatchObject({
			sql: { coverage: "postgres-uncovered", state: "uncovered" },
		});
		workers[0].finish();
		await pending.result;
	});
});
