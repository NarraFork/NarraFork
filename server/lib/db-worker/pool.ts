/** Read-only DB protocol over the shared bounded worker runtime. Never executes SQL locally. */
import { cpus } from "node:os";
import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotOnce, hotSafe, hotTimerClear } from "../hot-safe";
import { logger } from "../logger";
import { RUNTIME_BUILD_ID } from "../runtime-target";
import { currentSqlTraceSpan } from "../sql-trace";
import { WorkerCleanupError, WorkerHandle } from "../worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../worker-runtime/pool";
import { TaskQueueError } from "../worker-runtime/queue";
import { assertWorkerBuildId, workerFailureDetails } from "./failure";
import {
	DB_WORKER_READY_TIMEOUT_MS,
	type DbReadTaskParams,
	type DbWorkerOutbound,
} from "./protocol";

const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const MAX_SPAWN_FAILURES = 2;
export const DB_WORKER_MAX_QUEUE = 32;

export class DbReadTaskOverloadedError extends Error {
	readonly code = "DB_READ_TASK_OVERLOADED";
	constructor() {
		super("Database read worker queue is full");
		this.name = "DbReadTaskOverloadedError";
	}
}
export class DbReadTaskTimeoutError extends Error {
	readonly code = "DB_READ_TASK_TIMEOUT";
	constructor(message: string) {
		super(message);
		this.name = "DbReadTaskTimeoutError";
	}
}
export class DbReadTaskExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DbReadTaskExecutionError";
	}
}
export class WorkersUnavailableError extends Error {
	constructor(readonly reason: string) {
		super(`database read workers unavailable: ${reason}`);
		this.name = "WorkersUnavailableError";
	}
}
export interface RunReadTaskOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: { tableName: string; done: number; total: number }) => void;
	/** Coalesces execution, not subscriptions: only the last cancelled subscriber cancels SQL. */
	dedupeKey?: string;
}
interface ReadRequest {
	dbPath: string;
	params: DbReadTaskParams;
	traceParent?: string;
	onProgress?: RunReadTaskOptions["onProgress"];
}
interface SharedRead {
	controller: AbortController;
	promise: Promise<unknown>;
	subscribers: Set<{ progress?: RunReadTaskOptions["onProgress"] }>;
}
interface PoolState {
	runtimeVersion: 1;
	pool?: WorkerPool<ReadRequest, unknown>;
	ephemeral?: WorkerPool<ReadRequest, unknown>;
	inFlight: Map<string, SharedRead>;
	spawnFailures: number;
	failureReason: string | null;
	testSpecifiers: string[] | null;
	closing?: Promise<void>;
	paused: boolean;
	permanent: boolean;
	/** One-time HMR migration barrier. A failed legacy exit remains a permanent barrier. */
	upgrade?: Promise<void>;
}

/** Upgrade pre-runtime Bun Worker owners before allowing any replacement to start. */
function upgradeLegacy(s: PoolState): void {
	if (s.runtimeVersion === 1) return;
	const old = s as unknown as {
		workers?: Array<{
			worker: globalThis.Worker;
			detach?: () => void;
			readySignal?: {
				state: string;
				error: Error | null;
				waiters: Array<{ reject(error: Error): void }>;
			};
		}>;
		starting?: Set<NonNullable<typeof old.workers>[number]>;
		queue?: Array<{ fail(error: Error): void }>;
		pending?: Map<string, { timer: ReturnType<typeof setTimeout>; reject(error: Error): void }>;
		generation?: number;
		disabledReason?: string | null;
	};
	// Stale source closures read the legacy field. Keep them disabled even after this
	// runtime starts: hot reload must not resurrect the old scheduler alongside the new one.
	s.failureReason = old.disabledReason ?? null;
	old.disabledReason = "pool_shutdown";
	const error = new WorkersUnavailableError("pool_shutdown");
	old.generation = (old.generation ?? 0) + 1;
	hotTimerClear("narrafork.dbWorkerPool.reaper");
	for (const waiter of old.queue?.splice(0) ?? []) waiter.fail(error);
	for (const pending of old.pending?.values() ?? []) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	old.pending?.clear();
	const owners = new Set([...(old.workers ?? []), ...(old.starting ?? [])]);
	const exits = [...owners].map((owner) => {
		// Attach the exit observer BEFORE detaching legacy protocol listeners or stopping it.
		const exited = new Promise<number>((resolve) => {
			owner.worker.addEventListener("close", (event) => resolve((event as CloseEvent).code), {
				once: true,
			});
		});
		const handle = new WorkerHandle(owner.worker, exited, () => owner.worker.terminate());
		owner.detach?.();
		if (owner.readySignal?.state === "pending") {
			owner.readySignal.state = "failed";
			owner.readySignal.error = error;
			for (const waiter of owner.readySignal.waiters.splice(0)) waiter.reject(error);
		}
		return handle.close();
	});
	s.runtimeVersion = 1;
	s.pool = undefined;
	s.ephemeral = undefined;
	s.inFlight = new Map();
	s.paused = false;
	s.permanent = false;
	s.upgrade = Promise.all(exits).then(() => {
		// Old async factories can still unwind through their retired state after exit.
		// Leave empty compatibility containers, never a live legacy scheduler/owner.
		if (old.workers) old.workers.length = 0;
		old.starting?.clear();
		s.upgrade = undefined;
	});
	void s.upgrade.catch(() => {});
}
function state(): PoolState {
	const s = hotSafe<PoolState>("narrafork.dbWorkerPool", () => ({
		runtimeVersion: 1,
		inFlight: new Map(),
		spawnFailures: 0,
		failureReason: null,
		testSpecifiers: null,
		paused: false,
		permanent: false,
	}));
	upgradeLegacy(s);
	return s;
}
function workerSpecifierCandidates(): string[] {
	return (
		state().testSpecifiers ??
		compiledWorkerSpecifiers("lib/db-worker/worker-entry.ts", "./worker-entry.ts", import.meta.url)
	);
}
export function getConfiguredConcurrency(): number {
	const raw = process.env.NARRAFORK_DB_WORKER_CONCURRENCY?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 16);
		if (Number.isFinite(parsed) && parsed <= 0) return 0;
	}
	let cpuCount = 4;
	try {
		cpuCount = Math.max(1, cpus().length);
	} catch {
		/* keep default */
	}
	return Math.max(1, Math.min(4, cpuCount));
}
function workersDisabled(): string | null {
	const s = state();
	if (s.permanent || s.paused || s.closing) return "pool_shutdown";
	if (process.env.NARRAFORK_DB_WORKER === "off") return "disabled_by_env";
	if (getConfiguredConcurrency() === 0) return "concurrency_zero";
	return s.failureReason;
}
type WorkerFailurePhase = "create" | "ready" | "run" | "message" | "close" | "dispatch";
function logWorkerFailure(phase: WorkerFailurePhase, error: unknown): void {
	try {
		logger.warn("Database read worker failure", {
			phase,
			entry: "db-read-worker",
			buildId: RUNTIME_BUILD_ID,
			...workerFailureDetails(error, phase === "create" || phase === "ready"),
		});
	} catch {
		/* diagnostics cannot prevent cleanup */
	}
}
function taskError(error: unknown): unknown {
	if (error instanceof WorkerCleanupError)
		return new WorkersUnavailableError("worker_cleanup_failed");
	if (error instanceof TaskQueueError) {
		if (error.code === "TASK_QUEUE_FULL") return new DbReadTaskOverloadedError();
		if (error.code === "TASK_QUEUE_TIMEOUT")
			return new DbReadTaskTimeoutError("database read task timed out");
	}
	return error;
}
function cancellationError(context: WorkerTaskContext): Error {
	const error = taskError(context.signal.reason);
	return error instanceof WorkersUnavailableError || error instanceof DbReadTaskTimeoutError
		? error
		: new Error("database read task aborted");
}

/** Only DB RPC state lives here. Admission, reuse, idle timers and capacity belong to WorkerPool. */
async function createReader(
	context: WorkerTaskContext,
	ephemeral: boolean,
): Promise<PoolWorker<ReadRequest, unknown>> {
	const s = state();
	// Startup already owns a bounded queue permit while legacy owners finish exiting.
	await s.upgrade;
	if (context.signal.aborted) throw cancellationError(context);
	if (s.permanent || s.paused || s.closing) throw new WorkersUnavailableError("pool_shutdown");
	const disabled = workersDisabled();
	if (!ephemeral && disabled) throw new WorkersUnavailableError(disabled);
	let connected: Awaited<ReturnType<typeof connectCompiledWorker>>;
	try {
		connected = await connectCompiledWorker(workerSpecifierCandidates(), {
			signal: context.signal,
			deadlineAt: Math.min(context.deadlineAt, Date.now() + DB_WORKER_READY_TIMEOUT_MS),
			timeoutMs: DB_WORKER_READY_TIMEOUT_MS,
			isReady(message) {
				const ready = message as DbWorkerOutbound;
				if (ready?.type !== "ready") return false;
				assertWorkerBuildId(ready.buildId);
				return true;
			},
		});
	} catch (error) {
		// Shared runtime must retain this unconfirmed owner; translate only AFTER pool accounting.
		if (error instanceof WorkerCleanupError) throw error;
		if (context.signal.aborted) throw cancellationError(context);
		if (Date.now() >= context.deadlineAt)
			throw new DbReadTaskTimeoutError("database read task timed out before dispatch");
		logWorkerFailure("ready", error);
		if (!ephemeral && ++s.spawnFailures >= MAX_SPAWN_FAILURES)
			s.failureReason = "worker_unavailable";
		throw new WorkersUnavailableError(ephemeral ? "ephemeral_spawn_failed" : "worker_spawn_failed");
	}
	if (!ephemeral) s.spawnFailures = 0;
	const { worker, handle } = connected;
	return new ReadWorker(worker, handle);
}

class ReadWorker implements PoolWorker<ReadRequest, unknown> {
	private closing?: Promise<void>;
	private failed = false;
	private active?: {
		requestId: string;
		pg: boolean;
		cancel(error: Error): void;
		finish(error?: Error, value?: unknown): void;
		done: Promise<void>;
		onProgress?: RunReadTaskOptions["onProgress"];
	};
	constructor(
		private readonly worker: Worker,
		private readonly handle: WorkerHandle<Worker>,
	) {
		worker.on("message", this.onMessage);
		worker.on("error", this.onError);
		worker.on("messageerror", this.onMessageError);
		worker.on("exit", this.onExit);
	}
	get closed(): boolean {
		return this.failed || !!this.closing || this.handle.closed;
	}
	private onMessage = (message: DbWorkerOutbound) => {
		const active = this.active;
		if (!active || !message || message.type === "ready" || message.requestId !== active.requestId)
			return;
		if (message.type === "progress") {
			try {
				active.onProgress?.({
					tableName: message.tableName,
					done: message.done,
					total: message.total,
				});
			} catch {
				/* observational callbacks cannot strand a DB permit */
			}
		} else if (message.type === "result") active.finish(undefined, message.result);
		else {
			try {
				logger.warn("Database read worker query failed", {
					entry: "db-read-worker",
					phase: "read",
					buildId: RUNTIME_BUILD_ID,
					...workerFailureDetails(message.diagnostic ?? message, false),
				});
			} catch {
				/* diagnostics cannot prevent settlement */
			}
			active.finish(
				Object.assign(new DbReadTaskExecutionError(message.message), { code: message.code }),
			);
		}
	};
	private fail(phase: WorkerFailurePhase, error: unknown): void {
		this.failed = true;
		logWorkerFailure(phase, error);
		this.active?.finish(new DbReadTaskExecutionError("database worker died before completion"));
		void this.close().catch(() => {});
	}
	private onError = (error: Error) => this.fail("run", error);
	private onMessageError = () =>
		this.fail("message", new Error("worker message deserialization failed"));
	private onExit = () => {
		if (this.active) this.fail("close", new Error("worker closed before completion"));
	};
	run(request: ReadRequest, context: WorkerTaskContext): Promise<unknown> {
		if (this.closed) return Promise.reject(new WorkersUnavailableError("worker_unavailable"));
		return new Promise((resolve, reject) => {
			let cancelled: Error | undefined;
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			let done!: () => void;
			const drained = new Promise<void>((accept) => {
				done = accept;
			});
			const finish = (error?: Error, value?: unknown) => {
				if (this.active !== active) return;
				clearTimeout(watchdog);
				context.signal.removeEventListener("abort", abort);
				this.active = undefined;
				done();
				if (cancelled || error) reject(cancelled ?? error);
				else resolve(value);
			};
			const cancel = (error: Error) => {
				if (cancelled || this.active !== active) return;
				cancelled = error;
				if (!active.pg) {
					this.failed = true;
					finish(error);
					return;
				}
				// Terminal result/error is the DB protocol ACK: PG closes business AND control
				// connections first. Until ACK (or forced real exit) no permit can be returned.
				watchdog = setTimeout(() => {
					this.failed = true;
					finish(error);
				}, 1000);
				try {
					this.worker.postMessage({ type: "cancel", requestId: context.requestId });
				} catch {
					this.failed = true;
					finish(error);
				}
			};
			const abort = () => cancel(cancellationError(context));
			const active = {
				requestId: context.requestId,
				pg: request.params.kind === "displayPageMessagesPostgres",
				cancel,
				finish,
				done: drained,
				onProgress: request.onProgress,
			};
			this.active = active;
			context.signal.addEventListener("abort", abort, { once: true });
			if (context.signal.aborted) {
				abort();
				return;
			}
			try {
				this.worker.postMessage({
					type: "task",
					requestId: context.requestId,
					dbPath: request.dbPath,
					params: request.params,
					traceParent: request.traceParent,
				});
			} catch (error) {
				this.failed = true;
				logWorkerFailure("dispatch", error);
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	close(): Promise<void> {
		if (!this.closing) {
			const active = this.active;
			this.closing = Promise.resolve().then(async () => {
				if (active) {
					active.cancel(new WorkersUnavailableError("pool_shutdown"));
					await active.done;
				}
				try {
					this.worker.postMessage({ type: "shutdown" });
				} catch {
					/* already gone */
				}
				await this.handle.close();
				this.worker.off("message", this.onMessage);
				this.worker.off("error", this.onError);
				this.worker.off("messageerror", this.onMessageError);
				this.worker.off("exit", this.onExit);
			});
		}
		return this.closing;
	}
}

function runtime(ephemeral: boolean): WorkerPool<ReadRequest, unknown> {
	const s = state();
	const key = ephemeral ? "ephemeral" : "pool";
	s[key] ??= new WorkerPool({
		// The emergency one-shot scan is a separate bounded profile, never an unbounded escape hatch.
		concurrency: ephemeral ? 1 : Math.max(1, getConfiguredConcurrency()),
		maxQueued: DB_WORKER_MAX_QUEUE,
		maxQueuedBytes: 64 * 1024 * 1024,
		timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
		reuse: !ephemeral,
		create: (context) => createReader(context, ephemeral),
	});
	return s[key];
}
/** Constant-size/count-only accounting: never serialize or scan retained SQL parameters/body data. */
function requestBytes(request: ReadRequest): number {
	const params = request.params;
	if (params.kind === "selectRows") return 1024 + params.sql.length * 2 + 128 * 1024;
	if (params.kind === "storageScanTables") {
		const context = params.context;
		return (
			1024 +
			params.tableNames.length * 256 +
			(context
				? context.tables.length * 512 +
					context.dbstatBytes.length * 256 +
					context.indexesByTable.length * 512
				: 0)
		);
	}
	if (params.kind === "storageScanCleanupSummaries")
		return 1024 + (params.archivedNarratorIds.length + params.staleNarratorIds.length) * 128;
	return 256 * 1024;
}
function execute(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions,
	ephemeral: boolean,
): Promise<unknown> {
	const s = state();
	if (s.permanent || s.paused || s.closing)
		return Promise.reject(new WorkersUnavailableError("pool_shutdown"));
	const request = {
		dbPath,
		params,
		traceParent: currentSqlTraceSpan()?.id,
		onProgress: options.onProgress,
	};
	const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
	return runtime(ephemeral)
		.run(request, {
			signal: options.signal,
			deadlineAt,
			bytes: requestBytes(request),
		})
		.catch((error) => {
			throw taskError(error);
		});
}

function subscribe(shared: SharedRead, options: RunReadTaskOptions): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const subscriber = { progress: options.onProgress };
		shared.subscribers.add(subscriber);
		let settled = false;
		const finish = (error?: unknown, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			shared.subscribers.delete(subscriber);
			if (error !== undefined) reject(error);
			else resolve(value);
		};
		const cancel = (error: Error) => {
			finish(error);
			if (shared.subscribers.size === 0) shared.controller.abort(error);
		};
		const abort = () => cancel(new Error("database read task aborted"));
		const timer = setTimeout(
			() => cancel(new DbReadTaskTimeoutError("database read task timed out")),
			options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		shared.promise.then(
			(value) => finish(undefined, value),
			(error) => finish(error),
		);
	});
}
export async function runReadTask<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions = {},
): Promise<T> {
	const disabled = workersDisabled();
	if (disabled) throw new WorkersUnavailableError(disabled);
	if (options.signal?.aborted) throw new Error("database read task aborted");
	const s = state();
	if (!options.dedupeKey) return execute(dbPath, params, options, false) as Promise<T>;
	const key = `${dbPath}\0${options.dedupeKey}`;
	let shared = s.inFlight.get(key);
	if (!shared || shared.controller.signal.aborted) {
		const controller = new AbortController();
		const entry: SharedRead = { controller, promise: Promise.resolve(), subscribers: new Set() };
		entry.promise = execute(
			dbPath,
			params,
			{
				...options,
				signal: controller.signal,
				onProgress(progress) {
					for (const subscriber of entry.subscribers) subscriber.progress?.(progress);
				},
			},
			false,
		).finally(() => {
			if (s.inFlight.get(key) === entry) s.inFlight.delete(key);
		});
		s.inFlight.set(key, entry);
		shared = entry;
	}
	return subscribe(shared, options) as Promise<T>;
}
/** Bounded one-shot isolation when the reusable pool is disabled; never bypasses maintenance/exit. */
export async function runEphemeralReadTask<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions = {},
): Promise<T> {
	return execute(dbPath, params, options, true) as Promise<T>;
}

/** Real exit barrier. Default drains then permits explicit reuse; permanent is the process shutdown. */
export function shutdownDbWorkerPool(
	options: { permanent?: boolean; pause?: boolean } = {},
): Promise<void> {
	const s = state();
	s.permanent ||= options.permanent ?? false;
	s.paused ||= options.pause ?? false;
	if (s.closing) return s.closing;
	const reason = new WorkersUnavailableError("pool_shutdown");
	const pool = s.pool;
	const ephemeral = s.ephemeral;
	const closing = Promise.all([s.upgrade, pool?.close(reason), ephemeral?.close(reason)]).then(
		() => {
			if (s.pool === pool) s.pool = undefined;
			if (s.ephemeral === ephemeral) s.ephemeral = undefined;
			s.inFlight.clear();
			s.closing = undefined;
		},
	);
	s.closing = closing;
	// Failed close stays quarantined: no reset/reuse until real resource exit was confirmed.
	void closing.catch(() => {});
	return closing;
}
export function resumeDbWorkerPool(): void {
	const s = state();
	if (s.closing) throw new WorkersUnavailableError("pool_shutdown");
	if (!s.permanent) s.paused = false;
}
/** Explicit test reset waits for the prior owner; it cannot pretend a failed close freed capacity. */
export async function resetDbWorkerPoolForTest(): Promise<void> {
	const s = state();
	await shutdownDbWorkerPool();
	s.spawnFailures = 0;
	s.failureReason = null;
	s.testSpecifiers = null;
	s.paused = false;
	s.permanent = false;
}
export function setDbWorkerSpecifiersForTest(specifiers: string[] | null): void {
	state().testSpecifiers = specifiers;
}
export function getDbWorkerAvailability(): { available: boolean; reason: string | null } {
	const reason = workersDisabled();
	return { available: reason === null, reason };
}
export function getDbWorkerPoolStats() {
	const s = state();
	const stats = s.pool?.stats;
	return {
		workers: stats?.workers ?? 0,
		busy: stats ? stats.active - stats.starting : 0,
		queued: stats?.queued ?? 0,
		inFlight: s.inFlight.size,
		disabledReason: workersDisabled(),
		concurrency: getConfiguredConcurrency(),
		starting: stats?.starting ?? 0,
		claimed: stats ? stats.active - stats.starting : 0,
		spawnFailures: s.spawnFailures,
	};
}
if (hotOnce("narrafork.dbWorkerPool.exitHandler")) {
	process.on("exit", () => {
		void shutdownDbWorkerPool({ permanent: true }).catch(() => {});
	});
}
