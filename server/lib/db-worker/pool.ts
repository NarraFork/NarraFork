/** Read-only DB protocol over the shared bounded worker runtime. Never executes SQL locally. */
import { cpus } from "node:os";
import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotOnce, hotSafe, hotTimerClear } from "../hot-safe";
import { logger } from "../logger";
import {
	beginReadFanoutSpan,
	countReadFanout,
	endReadFanoutTiming,
	failReadFanoutPost,
	finishReadFanoutSpan,
	isReadFanoutScopeExcluded,
	postReadFanoutTask,
	type ReadFanoutSpan,
	readFanoutNow,
	receiveReadFanoutTask,
	recordReadFanoutSql,
	recordReadFanoutTiming,
	shareReadFanoutTask,
} from "../read-fanout-diagnostics";
import { RUNTIME_BUILD_ID } from "../runtime-target";
import { currentSqlTraceSpan } from "../sql-trace";
import { WorkerCleanupError, WorkerHandle } from "../worker-runtime/lifecycle";
import {
	type PoolWorker,
	WorkerPool,
	WorkerPoolError,
	type WorkerTaskContext,
} from "../worker-runtime/pool";
import { TaskQueueError } from "../worker-runtime/queue";
import {
	assertReadDatabaseOpen,
	closeReadDatabaseAdmission,
	getReadDatabaseIdentity,
	invalidateReadDatabaseReadiness,
	peekReadDatabaseIdentity,
	type ReadDatabaseIdentity,
} from "./database-identity";
import {
	DOMAIN_READ_STREAM_TIMEOUT_MS,
	isDomainReadStreamTask,
	validateDomainRead,
} from "./domain-protocol";
import { DbReadError, errorFromWorkerFailure, readAborted } from "./errors";
import { assertWorkerBuildId, workerFailureDetails } from "./failure";
import {
	assertSessionPreviewBudget,
	DB_WORKER_READY_TIMEOUT_MS,
	type DbReadTaskParams,
	type DbWorkerOutbound,
	SELECT_ROWS_MAX_BYTES,
	SELECT_ROWS_MAX_ROWS,
	SELECT_ROWS_MAX_SQL_BYTES,
	type SelectRowsParams,
	type SelectRowsResult,
} from "./protocol";
import { ReadBudgetMeter } from "./read-budget";
import {
	attachDbReadAbortDiagnostics,
	boundedReadLogText,
	type DbReadAbortDiagnostics,
	isTaskKind,
	logReadSqlDiagnostic,
	type ReadPoolTaskDiagnostics,
	type ReadTaskDiagnostics,
	readPoolTaskLabels,
	readPoolTaskSnapshot,
	warnReadBudgetExceeded,
	warnReadPoolFailure,
	warnReadPoolTaskTimeout,
	warnReadQueryRejected,
	warnReadQueueFull,
} from "./read-diagnostics";
import {
	classifyReadTask,
	DB_READ_DEFAULT_MAX_QUEUED,
	DB_READ_MAX_QUEUED_BYTES,
	type DbReadSchedulingConfig,
	readSchedulingConfig,
} from "./scheduling";
import { validateSelectDigestBatch } from "./select-digest-batch";
import { decodeReadBinds } from "./select-extended";
import { validateSelectRows } from "./select-rows";
import {
	acceptSqlDiagnosticEvent,
	createHostSqlDiagnosticState,
	createSqlDiagnosticConfig,
	getSqlDiagnosticSession,
	type SqlDiagnosticConfig,
} from "./sql-diagnostics";

let sqlDiagnosticWorkerCounter = 0;

const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const MAX_SPAWN_FAILURES = 2;
/** Main-pool defaults; instantiated pools retain their frozen configuration. */
export const DB_WORKER_MAX_QUEUE = DB_READ_DEFAULT_MAX_QUEUED;
export const DB_READ_QUEUE_MAX_TASKS = DB_READ_DEFAULT_MAX_QUEUED;
export const DB_READ_QUEUE_MAX_BYTES = DB_READ_MAX_QUEUED_BYTES;
const COMPATIBLE_EPHEMERAL_MAX_QUEUED = 32;
const ACTIVE_DIAGNOSTIC_LIMIT = 8;
const QUEUE_DIAGNOSTIC_LIMIT = 32;
const SHORT_READ_TIMEOUT_MS = 5_000;
const SHORT_READ_MAX_QUEUE = 8;
const SHORT_READ_MAX_QUEUE_BYTES = 2 * 1024 * 1024;

export class DbReadTaskOverloadedError extends Error {
	readonly code = "DB_READ_TASK_OVERLOADED";
	constructor(readonly reason?: TaskQueueError["reason"]) {
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
	readonly code = "DB_READ_UNAVAILABLE";
	constructor(readonly reason: string) {
		super(`database read workers unavailable: ${reason}`);
		this.name = "WorkersUnavailableError";
	}
}
export interface RunReadTaskOptions {
	timeoutMs?: number;
	deadlineAt?: number;
	schedulingHint?: "auth-session";
	signal?: AbortSignal;
	/** Static server-owned label, never bound values or user content. */
	diagnosticSource?: string;
	diagnosticContext?: ReadTaskDiagnostics;
	onProgress?: (progress: { tableName: string; done: number; total: number }) => void;
	/** Coalesces execution, not subscriptions: only the last cancellation cancels SQL. */
	dedupeKey?: string;
	/** Consumption must settle before the worker is allowed to send another block. */
	onChunk?: (chunk: import("./protocol").SelectChunk) => void | Promise<void>;
}
interface ReadRequest {
	poolDiagnostic: ReadPoolTaskDiagnostics;
	sqlDiagnostic?: SqlDiagnosticConfig;
	dbPath: string;
	identity?: ReadDatabaseIdentity;
	params: DbReadTaskParams;
	traceParent?: string;
	callerSignal?: AbortSignal;
	onProgress?: RunReadTaskOptions["onProgress"];
	onChunk?: RunReadTaskOptions["onChunk"];
	fresh: boolean;
	taskClass: "normal" | "short";
	profile: ReadPoolProfile;
	compatibleEphemeral: boolean;
	diagnostics: ReadTaskDiagnostics;
	phase: { phase: DbReadAbortDiagnostics["phase"] };
	fanout?: ReadFanoutSpan;
	fanoutExcluded: boolean;
}
interface SharedRead {
	request: ReadRequest;
	controller: AbortController;
	promise: Promise<unknown>;
	subscribers: Set<{ progress?: RunReadTaskOptions["onProgress"] }>;
}
type ReadPoolProfile = "pool" | "ephemeral" | "shortReads";
/** Resource bookkeeping only; WorkerPool alone owns scheduling and capacity. */
interface ReaderOwner {
	databaseIds: Set<string>;
	exited: Promise<unknown>;
	close(): Promise<void>;
	readonly closed: boolean;
}
interface OwnedRead {
	request: ReadRequest;
	controller: AbortController;
	settled: Promise<unknown>;
}
interface PoolState {
	runtimeVersion: 3;
	config?: DbReadSchedulingConfig;
	pool?: WorkerPool<ReadRequest, unknown>;
	ephemeral?: WorkerPool<ReadRequest, unknown>;
	shortReads?: WorkerPool<ReadRequest, unknown>;
	inFlight: Map<string, SharedRead>;
	requests: Map<string, OwnedRead>;
	owners: Set<ReaderOwner>;
	requestCounter: number;
	spawnFailures: number;
	failureReason: string | null;
	testSpecifiers: string[] | null;
	closing?: Promise<void>;
	paused: boolean;
	permanent: boolean;
	upgrade?: Promise<void>;
	/** A sealed legacy root remains visible only to its old module closures. */
	replacement?: PoolState;
}

/** Retire legacy owners without exposing replacement state to their surviving closures. */
function upgradeLegacy(s: PoolState): PoolState {
	if (s.replacement) return upgradeLegacy(s.replacement);
	if (s.runtimeVersion === 3) return s;
	const next: PoolState = {
		runtimeVersion: 3,
		inFlight: new Map(),
		requests: new Map(),
		owners: new Set(),
		requestCounter: Number.isSafeInteger(s.requestCounter) ? s.requestCounter : 0,
		spawnFailures: s.spawnFailures ?? 0,
		failureReason: s.failureReason ?? null,
		testSpecifiers: s.testSpecifiers ?? null,
		paused: s.paused ?? false,
		permanent: s.permanent ?? false,
	};
	let resolveUpgrade!: () => void;
	let rejectUpgrade!: (error: unknown) => void;
	next.upgrade = new Promise<void>((resolve, reject) => {
		resolveUpgrade = resolve;
		rejectUpgrade = reject;
	});
	void next.upgrade.catch(() => {});
	const previousUpgrade = s.upgrade;
	const previousClosing = s.closing;
	const replaced = Promise.reject<void>(new WorkersUnavailableError("pool_runtime_replaced"));
	void replaced.catch(() => {});
	// Old shutdown/close exports must never report that they drained replacement readers.
	// Their in-flight finally callbacks cannot clear these sealed lifecycle barriers.
	for (const key of ["closing", "upgrade"] as const)
		Object.defineProperty(s, key, {
			configurable: false,
			enumerable: true,
			get: () => replaced,
			set: () => {},
		});
	// Publish a blocked replacement before close invokes any synchronous cancellation observers.
	s.replacement = next;
	s.paused = true;
	s.permanent = true;
	const old = s as unknown as {
		runtimeVersion?: number;
		pool?: WorkerPool<ReadRequest, unknown>;
		ephemeral?: WorkerPool<ReadRequest, unknown>;
		shortReads?: WorkerPool<ReadRequest, unknown>;
		upgrade?: Promise<void>;
		workers?: Array<{
			worker: globalThis.Worker;
			exited?: Promise<unknown>;
			detach?: () => void;
			readySignal?: {
				state: string;
				error: Error | null;
				waiters: Array<{ reject(error: Error): void }>;
			};
		}>;
		tracked?: Set<NonNullable<typeof old.workers>[number]>;
		starting?: Set<NonNullable<typeof old.workers>[number]>;
		queue?: Array<{ fail(error: Error): void }>;
		pending?: Map<string, { timer: ReturnType<typeof setTimeout>; reject(error: Error): void }>;
		generation?: number;
		admissionClosed?: boolean;
		disabledReason?: string | null;
	};
	const error = new WorkersUnavailableError("pool_shutdown");
	const exits: Promise<unknown>[] = [
		previousUpgrade ?? Promise.resolve(),
		previousClosing ?? Promise.resolve(),
	];
	try {
		if (old.runtimeVersion === 1 || old.runtimeVersion === 2) {
			exits.push(
				old.pool?.close(error) ?? Promise.resolve(),
				old.ephemeral?.close(error) ?? Promise.resolve(),
				old.shortReads?.close(error) ?? Promise.resolve(),
			);
		} else {
			next.failureReason = old.disabledReason ?? null;
			old.disabledReason = "pool_shutdown";
			old.admissionClosed = true;
			old.generation = (old.generation ?? 0) + 1;
			hotTimerClear("narrafork.dbWorkerPool.reaper");
			for (const waiter of old.queue?.splice(0) ?? []) waiter.fail(error);
			for (const pending of old.pending?.values() ?? []) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			old.pending?.clear();
			const owners = new Set([
				...(old.workers ?? []),
				...(old.starting ?? []),
				...(old.tracked ?? []),
			]);
			for (const owner of owners) {
				const exited =
					owner.exited ??
					new Promise<number>((resolve) => {
						owner.worker.addEventListener("close", (event) => resolve((event as CloseEvent).code), {
							once: true,
						});
					});
				const handle = new WorkerHandle(
					owner.worker,
					exited.then(() => 0),
					() => owner.worker.terminate(),
				);
				owner.detach?.();
				if (owner.readySignal?.state === "pending") {
					owner.readySignal.state = "failed";
					owner.readySignal.error = error;
					for (const waiter of owner.readySignal.waiters.splice(0)) waiter.reject(error);
				}
				exits.push(handle.close());
			}
		}
	} catch (error) {
		exits.push(Promise.reject(error));
	}
	void Promise.all(exits).then(
		() => {
			if (old.workers) old.workers.length = 0;
			old.starting?.clear();
			old.tracked?.clear();
			next.upgrade = undefined;
			resolveUpgrade();
		},
		(error: unknown) => {
			next.failureReason = "pool_upgrade_failed";
			rejectUpgrade(error);
		},
	);
	return next;
}
function state(): PoolState {
	const s = hotSafe<PoolState>("narrafork.dbWorkerPool", () => ({
		runtimeVersion: 3,
		inFlight: new Map(),
		requests: new Map(),
		owners: new Set(),
		requestCounter: 0,
		spawnFailures: 0,
		failureReason: null,
		testSpecifiers: null,
		paused: false,
		permanent: false,
	}));
	return upgradeLegacy(s);
}
function workerSpecifierCandidates(): string[] {
	return (
		state().testSpecifiers ??
		compiledWorkerSpecifiers("lib/db-worker/worker-entry.ts", "./worker-entry.ts", import.meta.url)
	);
}
let defaultConcurrency: number | undefined;
export function getConfiguredConcurrency(): number {
	const raw = process.env.NARRAFORK_DB_WORKER_CONCURRENCY?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 16);
		if (Number.isFinite(parsed) && parsed <= 0) return 0;
	}
	if (defaultConcurrency === undefined) {
		let cpuCount = 4;
		try {
			cpuCount = Math.max(1, cpus().length);
		} catch {
			/* keep default */
		}
		defaultConcurrency = Math.max(2, Math.min(4, cpuCount));
	}
	return defaultConcurrency;
}
function workersDisabled(profile: ReadPoolProfile = "pool"): string | null {
	const s = state();
	if (s.upgrade)
		return s.failureReason === "pool_upgrade_failed" ? s.failureReason : "pool_upgrading";
	if (s.permanent || s.paused || s.closing) return "pool_shutdown";
	if (profile !== "ephemeral" && process.env.NARRAFORK_DB_WORKER === "off")
		return "disabled_by_env";
	const concurrency =
		profile === "pool"
			? (s.config?.concurrency ?? getConfiguredConcurrency())
			: getConfiguredConcurrency();
	if (concurrency === 0) return "concurrency_zero";
	if (profile !== "pool") return null;
	if (!s.config) {
		try {
			readSchedulingConfig(concurrency);
		} catch (error) {
			return error instanceof Error ? error.message : "invalid_scheduling_config";
		}
	}
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
		return Object.assign(
			new DbReadError("DB_READ_READER_EXIT_UNCONFIRMED", "database reader exit was not confirmed"),
			{ reason: "worker_cleanup_failed" },
		);
	if (error instanceof WorkerPoolError) return new WorkersUnavailableError("worker_unavailable");
	if (error instanceof TaskQueueError) {
		if (error.code === "TASK_QUEUE_FULL") {
			if (error.reason === "total-bytes" || error.reason === "normal-bytes")
				return Object.assign(new DbReadError("DB_READ_OVERLOADED", "database read queue is full"), {
					reason: error.reason,
				});
			return new DbReadTaskOverloadedError(error.reason);
		}
		if (error.code === "TASK_QUEUE_TIMEOUT")
			return new DbReadTaskTimeoutError("database read task timed out");
		if (error.code === "TASK_QUEUE_CLOSED") return new WorkersUnavailableError("pool_shutdown");
	}
	return error;
}
function cancellationError(context: WorkerTaskContext): Error {
	const error = taskError(context.signal.reason);
	return error instanceof WorkersUnavailableError ||
		error instanceof DbReadTaskTimeoutError ||
		error instanceof DbReadError
		? error
		: readAborted();
}
function trackOwner(owner: ReaderOwner, requestId?: string): void {
	const s = state();
	if (requestId) requestOwners.get(requestId)?.add(owner);
	s.owners.add(owner);
	void owner.exited.then(
		() => s.owners.delete(owner),
		() => {},
	);
}
async function createReader(
	context: WorkerTaskContext,
	profile: ReadPoolProfile,
): Promise<PoolWorker<ReadRequest, unknown>> {
	const s = state();
	const request = s.requests.get(context.requestId)?.request;
	if (request) request.phase.phase = "acquiring";
	const coldStarted = readFanoutNow(request?.fanout);
	try {
		await s.upgrade;
		if (context.signal.aborted) throw cancellationError(context);
		const disabled = workersDisabled(profile);
		if (disabled) throw new WorkersUnavailableError(disabled);
		if (request?.identity) assertReadDatabaseOpen(request.identity);
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
			if (error instanceof WorkerCleanupError) {
				trackOwner(
					{
						databaseIds: new Set(request?.identity ? [request.identity.id] : []),
						exited: error.handle.exited,
						closed: true,
						close: async () => {
							await error.handle.exited;
						},
					},
					context.requestId,
				);
				// Preserve the concrete error until WorkerPool has quarantined its native slot.
				throw error;
			}
			if (context.signal.aborted) throw cancellationError(context);
			if (Date.now() >= context.deadlineAt)
				throw new DbReadTaskTimeoutError("database read task timed out before dispatch");
			logWorkerFailure("ready", error);
			// Short reads retry within their own bounded profile without poisoning ordinary reads.
			if (profile === "pool" && ++s.spawnFailures >= MAX_SPAWN_FAILURES)
				s.failureReason = "worker_unavailable";
			throw new WorkersUnavailableError(
				profile === "ephemeral" ? "ephemeral_spawn_failed" : "worker_spawn_failed",
			);
		}
		if (profile === "pool") s.spawnFailures = 0;
		const reader = new ReadWorker(connected.worker, connected.handle);
		if (request?.identity) reader.databaseIds.add(request.identity.id);
		trackOwner(reader, context.requestId);
		return reader;
	} finally {
		endReadFanoutTiming(request?.fanout, "coldStart", coldStarted);
	}
}

class ReadWorker implements PoolWorker<ReadRequest, unknown>, ReaderOwner {
	readonly databaseIds = new Set<string>();
	readonly exited: Promise<number>;
	private closing?: Promise<void>;
	private failed = false;
	private diagnosticWorker?: string;
	private lastDiagnostic?: ReadPoolTaskDiagnostics;
	private active?: {
		request: ReadRequest;
		requestId: string;
		pg: boolean;
		consumeSequence?: number;
		nextSequence: number;
		cancel(error: Error): void;
		finish(error?: Error, value?: unknown): void;
		done: Promise<void>;
	};
	constructor(
		private readonly worker: Worker,
		private readonly handle: WorkerHandle<Worker>,
	) {
		this.exited = handle.exited;
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
		const request = active.request;
		if (message.type === "sqlDiagnostic") {
			const sql = request.poolDiagnostic.sql;
			if (sql) {
				const accepted = acceptSqlDiagnosticEvent(sql, message, Date.now());
				logReadSqlDiagnostic(
					accepted && message.phase !== "coverageLost"
						? message.phase === "start"
							? "sql-start"
							: "sql-end"
						: "coverage-lost",
					request.poolDiagnostic,
				);
			}
			return;
		}
		if (message.type === "progress") {
			try {
				request.onProgress?.({
					tableName: message.tableName,
					done: message.done,
					total: message.total,
				});
			} catch {
				/* observational callbacks cannot strand a permit */
			}
			return;
		}
		try {
			request.diagnostics.meter.merge(message.diagnostics);
			if (message.type === "result") request.diagnostics.partial = false;
		} catch {
			/* diagnostic metadata cannot affect delivery or ACK */
		}
		if (message.type === "chunk") {
			if (
				!request.onChunk ||
				active.consumeSequence !== undefined ||
				message.chunk.sequence !== active.nextSequence
			) {
				active.cancel(new DbReadError("DB_READ_PROTOCOL", "Invalid database read chunk"));
				return;
			}
			active.consumeSequence = message.chunk.sequence;
			void new Promise<void>((resolve) => setTimeout(resolve, 0))
				.then(() => {
					if (this.active === active && !this.closed) return request.onChunk?.(message.chunk);
				})
				.then(() => {
					if (this.active !== active || this.closed) return;
					active.consumeSequence = undefined;
					active.nextSequence = message.chunk.sequence + 1;
					this.worker.postMessage({
						type: "chunkAck",
						requestId: active.requestId,
						sequence: message.chunk.sequence,
					});
				})
				.catch(() =>
					active.cancel(
						new DbReadError("DB_READ_CONSUMER_FAILED", "database read consumer failed"),
					),
				);
			return;
		}
		receiveReadFanoutTask(
			request.fanout,
			message.type,
			message.type === "result" ? message.durationMs : undefined,
			request.fanoutExcluded,
		);
		if (message.type === "result") {
			if (active.consumeSequence !== undefined)
				active.cancel(new DbReadError("DB_READ_PROTOCOL", "Result arrived before chunk ACK"));
			else active.finish(undefined, message.result);
		} else {
			if (message.code === "DB_READ_SNAPSHOT_CLEANUP_FAILED") this.failed = true;
			try {
				logger.warn("Database read worker query failed", {
					entry: "db-read-worker",
					phase: "read",
					buildId: RUNTIME_BUILD_ID,
					...workerFailureDetails(message.diagnostic ?? message, false),
					...(request.poolDiagnostic.sql
						? readPoolTaskSnapshot(
								request.poolDiagnostic,
								Date.now(),
								request.poolDiagnostic.dispatchedAt,
							)
						: {}),
				});
			} catch {
				/* diagnostics cannot prevent settlement */
			}
			active.finish(
				message.code?.startsWith("DB_READ_") || message.statusCode !== undefined
					? errorFromWorkerFailure(message)
					: Object.assign(
							new DbReadTaskExecutionError(message.message || "database worker query failed"),
							{ code: message.code },
						),
			);
		}
	};
	private fail(phase: WorkerFailurePhase, error: unknown): void {
		this.failed = true;
		logWorkerFailure(phase, error);
		this.active?.finish(
			new DbReadError("DB_READ_WORKER_EXITED", "database worker died before completion"),
		);
		void this.close().catch(() => {});
	}
	private onError = (error: Error) => this.fail("run", error);
	private onMessageError = () =>
		this.fail("message", new Error("worker message deserialization failed"));
	private onExit = () => {
		if (this.active) this.fail("close", new Error("worker closed before completion"));
	};
	run(request: ReadRequest, context: WorkerTaskContext): Promise<unknown> {
		requestOwners.get(context.requestId)?.add(this);
		if (this.closed) return Promise.reject(new WorkersUnavailableError("worker_unavailable"));
		if (request.identity) {
			assertReadDatabaseOpen(request.identity);
			this.databaseIds.add(request.identity.id);
		}
		request.diagnostics.requestId = context.requestId;
		request.poolDiagnostic.requestId = context.requestId;
		request.poolDiagnostic.dispatchedAt = Date.now();
		request.phase.phase = "dispatching";
		this.lastDiagnostic = request.poolDiagnostic.sql ? request.poolDiagnostic : undefined;
		if (request.poolDiagnostic.sql) {
			this.diagnosticWorker ??= `dbw-${++sqlDiagnosticWorkerCounter}`;
			request.poolDiagnostic.sql.worker = this.diagnosticWorker;
			this.lastDiagnostic = request.poolDiagnostic;
			logReadSqlDiagnostic("dispatch", request.poolDiagnostic);
		}
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
				if (request.poolDiagnostic.sql) {
					request.poolDiagnostic.sql.endedAt = Date.now();
					request.poolDiagnostic.sql.outcome = cancelled || error ? "failed" : "completed";
					logReadSqlDiagnostic("finish", request.poolDiagnostic);
				}
				this.active = undefined;
				if (request.fresh) this.failed = true;
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
				// PG ACK follows native cancellation and both connection closes. Never reuse early.
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
				request,
				requestId: context.requestId,
				pg: request.params.kind === "displayPageMessagesPostgres",
				nextSequence: 0,
				cancel,
				finish,
				done: drained,
			};
			this.active = active;
			context.signal.addEventListener("abort", abort, { once: true });
			if (request.callerSignal?.aborted || context.signal.aborted) {
				abort();
				return;
			}
			try {
				this.worker.postMessage({
					type: "task",
					requestId: context.requestId,
					dbPath: request.dbPath,
					databaseId: request.identity?.id,
					deadlineAt: context.deadlineAt,
					params: request.params,
					traceParent: request.traceParent,
					...(request.sqlDiagnostic ? { sqlDiagnostic: request.sqlDiagnostic } : {}),
				});
				postReadFanoutTask(request.fanout);
				request.phase.phase = "running";
			} catch (error) {
				this.failed = true;
				logWorkerFailure("dispatch", error);
				failReadFanoutPost(request.fanout);
				finish(new DbReadError("DB_READ_FAILED", "database read task dispatch failed"));
			}
		});
	}
	close(): Promise<void> {
		if (!this.closing) {
			const active = this.active;
			const diagnostic = this.lastDiagnostic;
			const closeStartedAt = diagnostic ? Date.now() : undefined;
			logReadSqlDiagnostic("close-start", diagnostic);
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
				logReadSqlDiagnostic(
					"close-complete",
					diagnostic,
					closeStartedAt === undefined ? undefined : Math.max(0, Date.now() - closeStartedAt),
				);
				this.worker.off("message", this.onMessage);
				this.worker.off("error", this.onError);
				this.worker.off("messageerror", this.onMessageError);
				this.worker.off("exit", this.onExit);
			});
		}
		return this.closing;
	}
}
function runtime(profile: ReadPoolProfile): WorkerPool<ReadRequest, unknown> {
	const s = state();
	const short = profile === "shortReads";
	if (profile === "pool") s.config ??= readSchedulingConfig(getConfiguredConcurrency());
	const config = profile === "pool" ? s.config : undefined;
	s[profile] ??= new WorkerPool({
		// Short reads and the one-shot emergency scan each have their own bounded slot.
		concurrency: config?.concurrency ?? 1,
		maxQueued: short
			? SHORT_READ_MAX_QUEUE
			: (config?.maxQueued ?? COMPATIBLE_EPHEMERAL_MAX_QUEUED),
		maxQueuedBytes: short
			? SHORT_READ_MAX_QUEUE_BYTES
			: (config?.maxQueuedBytes ?? DB_READ_QUEUE_MAX_BYTES),
		...(config
			? {
					reservedCapacity: config.reservedCapacity,
					normalQueue: {
						maxQueued: config.normalMaxQueued,
						maxQueuedBytes: config.normalMaxQueuedBytes,
					},
				}
			: {}),
		timeoutMs: short ? SHORT_READ_TIMEOUT_MS : DEFAULT_TASK_TIMEOUT_MS,
		reuse: profile !== "ephemeral",
		create: (context) => createReader(context, profile),
		onTaskComplete(timing) {
			const request = s.requests.get(timing.requestId)?.request;
			if (!request) return;
			recordReadFanoutTiming(request.fanout, "workerAcquire", timing.readyMs);
			if (request.poolDiagnostic.queuedAt !== undefined)
				recordReadFanoutTiming(request.fanout, "queueWait", timing.queueMs);
		},
	});
	return s[profile];
}
function logQueueRejection(
	request: ReadRequest,
	bytes: number,
	profile: ReadPoolProfile,
	reason: TaskQueueError["reason"],
): void {
	try {
		const s = state();
		const stats = runtime(profile).stats;
		warnReadQueueFull(
			{
				reason:
					reason === "normal-count" || reason === "normal-bytes"
						? reason
						: reason === "total-bytes"
							? "bytes"
							: "count",
				taskClass: request.taskClass,
				reservedCapacity: stats.reservedCapacity,
				normalCapacity: stats.normalCapacity,
				normalMaxQueued: stats.normalQueue?.maxQueued,
				normalMaxQueuedBytes: stats.normalQueue?.maxQueuedBytes,
				activeByClass: stats.activeByClass,
				queuedByClass: stats.queuedByClass,
				queuedBytesByClass: stats.queuedBytesByClass,
				reservation: stats.reservation,
				taskKind: request.poolDiagnostic.kind,
				queued: stats.queued,
				queuedBytes: stats.queuedBytes,
				incomingBytes: bytes,
				maxQueued: stats.maxQueued,
				maxQueuedBytes: stats.maxQueuedBytes,
				workers: stats.workers,
				busy: stats.active - stats.starting,
				retiring: stats.retiring,
				pendingSpawns: stats.starting,
				concurrency: stats.concurrency,
			},
			() => {
				const now = Date.now();
				const active = [];
				const queued = [];
				let activeTotal = 0;
				let queuedTotal = 0;
				const activeMaxEntries = Math.min(ACTIVE_DIAGNOSTIC_LIMIT, stats.concurrency);
				for (const owned of s.requests.values()) {
					const item = owned.request;
					if (item === request || item.profile !== profile) continue;
					if (item.phase.phase === "running" || item.phase.phase === "dispatching") {
						activeTotal++;
						if (active.length < activeMaxEntries)
							active.push(
								readPoolTaskSnapshot(item.poolDiagnostic, now, item.poolDiagnostic.dispatchedAt),
							);
					} else if (item.phase.phase === "queued") {
						queuedTotal++;
						if (queued.length < QUEUE_DIAGNOSTIC_LIMIT)
							queued.push(
								readPoolTaskSnapshot(item.poolDiagnostic, now, item.poolDiagnostic.queuedAt),
							);
					}
				}
				return {
					kind: request.poolDiagnostic.kind,
					source: request.poolDiagnostic.source,
					code: "TASK_QUEUE_FULL",
					incomingTask: readPoolTaskSnapshot(
						request.poolDiagnostic,
						now,
						request.poolDiagnostic.startedAt,
					),
					activeTasks: active,
					activeTotal,
					activeMaxEntries,
					activeTruncated: activeTotal > active.length,
					queuedTasks: queued,
					queuedMaxEntries: QUEUE_DIAGNOSTIC_LIMIT,
					queuedTruncated: queuedTotal > queued.length,
				};
			},
		);
	} catch {
		/* pressure evidence cannot replace the admission failure */
	}
}
function execute(
	request: ReadRequest,
	options: RunReadTaskOptions,
	deadlineAt: number,
	bytes: number,
	profile: ReadPoolProfile,
): Promise<unknown> {
	const s = state();
	const disabled = workersDisabled(profile);
	if (disabled) return Promise.reject(new WorkersUnavailableError(disabled));
	const requestId = request.poolDiagnostic.requestId;
	if (!requestId)
		return Promise.reject(new DbReadError("DB_READ_INVALID", "Missing database read request id"));
	request.callerSignal = options.signal;
	const controller = new AbortController();
	const forwardAbort = () => {
		const reason = options.signal?.reason;
		controller.abort(
			reason instanceof DbReadError ||
				reason instanceof WorkersUnavailableError ||
				reason instanceof DbReadTaskTimeoutError
				? reason
				: readAborted(),
		);
	};
	options.signal?.addEventListener("abort", forwardAbort, { once: true });
	if (options.signal?.aborted) forwardAbort();
	const pool = runtime(profile);
	request.phase.phase = "acquiring";
	const owned: OwnedRead = { request, controller, settled: Promise.resolve() };
	s.requests.set(requestId, owned);
	owned.settled = pool
		.run(request, {
			requestId: requestId,
			signal: controller.signal,
			deadlineAt,
			bytes,
			fresh: request.fresh,
			taskClass: request.taskClass,
			onAdmission(event) {
				request.phase.phase = event.phase === "queued" ? "queued" : "acquiring";
				if (event.phase === "queued") {
					request.poolDiagnostic.queuedAt = event.at;
					request.poolDiagnostic.queueReason = event.reason;
				}
			},
		})
		.catch((error) => {
			if (
				error instanceof TaskQueueError &&
				error.code !== "TASK_QUEUE_FULL" &&
				error.code !== "TASK_QUEUE_TIMEOUT"
			)
				warnReadPoolFailure(request.poolDiagnostic, error.code, runtime(profile).stats);
			if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL") {
				logQueueRejection(request, bytes, profile, error.reason);
			}
			throw taskError(error);
		})
		.finally(() => {
			s.requests.delete(requestId);
			options.signal?.removeEventListener("abort", forwardAbort);
		});
	return owned.settled;
}
function subscribe(
	shared: SharedRead,
	options: RunReadTaskOptions,
	deadlineAt: number,
): Promise<unknown> {
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
			const request = shared.request;
			attachDbReadAbortDiagnostics(error, {
				kind: request.params.kind,
				domainTask: request.params.kind === "domainRead" ? request.params.task : undefined,
				phase: request.phase.phase,
				taskId: request.diagnostics.requestId,
			});
			finish(error);
			if (shared.subscribers.size === 0) shared.controller.abort(error);
		};
		const abort = () => cancel(readAborted());
		const timer = setTimeout(
			() => cancel(new DbReadTaskTimeoutError("database read task timed out")),
			Math.max(0, deadlineAt - Date.now()),
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const deliver = (error?: unknown, value?: unknown) => {
			if (settled) return;
			if (options.signal?.aborted) return cancel(readAborted());
			if (Date.now() >= deadlineAt)
				return cancel(new DbReadTaskTimeoutError("database read task timed out"));
			finish(error, value);
		};
		shared.promise.then(
			(value) => deliver(undefined, value),
			(error) => deliver(error),
		);
	});
}
export function runReadTask<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions = {},
): Promise<T> {
	return runReadTaskInternal<T>(dbPath, params, options, false);
}
/** Opt-in for indexed, bounded SQLite SELECTs; does not share the ordinary read queue. */
export function runShortReadTask(
	dbPath: string,
	params: SelectRowsParams,
	options: Pick<RunReadTaskOptions, "signal" | "timeoutMs" | "diagnosticSource"> = {},
): Promise<SelectRowsResult> {
	return runReadTaskInternal<SelectRowsResult>(
		dbPath,
		params,
		options,
		false,
		false,
		undefined,
		"shortReads",
	);
}
/** Bounded one-shot isolation may bypass a disabled reusable pool, never maintenance/exit. */
export function runEphemeralReadTask<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions = {},
): Promise<T> {
	return runReadTaskInternal<T>(dbPath, params, options, true, true);
}
export interface TrackedEphemeralReadTask<T> {
	readonly result: Promise<T>;
	/** Includes startup failure cleanup and actual native exit, not just a termination request. */
	readonly released: Promise<void>;
}
export function runTrackedEphemeralReadTask<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions = {},
): TrackedEphemeralReadTask<T> {
	const owners = new Set<ReaderOwner>();
	const result = options.dedupeKey
		? Promise.reject<T>(
				new DbReadError("DB_READ_INVALID", "Owned ephemeral reads cannot share executions"),
			)
		: runReadTaskInternal<T>(dbPath, params, options, true, false, owners);
	const released = result
		.then(
			() => undefined,
			() => undefined,
		)
		.then(async () => {
			await Promise.all([...owners].map((owner) => owner.exited));
		});
	return { result, released };
}

function taskParameterBytes(input: unknown): number {
	let bytes = 0;
	const walk = (value: unknown, depth: number): void => {
		if (depth > 32) throw new DbReadError("DB_READ_INVALID", "Invalid database read parameters");
		if (typeof value === "string") bytes += Buffer.byteLength(value) + 8;
		else if (value instanceof Uint8Array) bytes += value.byteLength + 32;
		else if (value && typeof value === "object") {
			if (Array.isArray(value)) bytes += value.length * 8;
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				bytes += Buffer.byteLength(key) + 8;
				walk((value as Record<string, unknown>)[key], depth + 1);
				if (bytes > DB_READ_QUEUE_MAX_BYTES) break;
			}
		} else bytes += 16;
	};
	walk(input, 0);
	return bytes;
}
async function runReadTaskInternal<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions,
	fresh: boolean,
	compatibleEphemeral = false,
	exitTracker?: Set<ReaderOwner>,
	profile: ReadPoolProfile = compatibleEphemeral ? "ephemeral" : "pool",
): Promise<T> {
	// Capture the host caller before the first asynchronous boundary.
	const sqlSession = getSqlDiagnosticSession();
	const sqlDiagnostic = sqlSession ? createSqlDiagnosticConfig(sqlSession) : undefined;
	const sql = sqlDiagnostic
		? createHostSqlDiagnosticState(sqlDiagnostic, params.kind === "displayPageMessagesPostgres")
		: undefined;
	const fanout = beginReadFanoutSpan("pool");
	const fanoutExcluded = !fanout && isReadFanoutScopeExcluded();
	if (fanout) {
		try {
			if ("sql" in params) recordReadFanoutSql(fanout, params.sql);
			else countReadFanout(fanout, "poolTemplateUnknown");
		} catch {
			/* observations cannot change malformed-task handling */
		}
	}
	let fanoutError: unknown;
	const startedAt = Date.now();
	const diagnostics: ReadTaskDiagnostics = { meter: new ReadBudgetMeter(), partial: true };
	const abortContext: { phase: DbReadAbortDiagnostics["phase"] } = { phase: "admission" };
	let poolDiagnostic: ReadPoolTaskDiagnostics | undefined;
	let status: "completed" | "failed" = "failed";
	let code: string | undefined;
	let shared = false;
	let rejected = false;
	try {
		if (!isTaskKind(params.kind))
			throw new DbReadError("DB_READ_INVALID", "Unknown database read task kind");
		const stream = isDomainReadStreamTask(params);
		if (stream && (!fresh || !exitTracker || compatibleEphemeral))
			throw new DbReadError("DB_READ_INVALID", "Domain streams require a tracked one-shot worker");
		const scheduling = classifyReadTask(params, options.schedulingHint);
		const disabled = workersDisabled(profile);
		if (disabled) throw new WorkersUnavailableError(disabled);
		if (options.signal?.aborted) throw readAborted();
		const timeoutMs = stream
			? Math.min(options.timeoutMs ?? DOMAIN_READ_STREAM_TIMEOUT_MS, DOMAIN_READ_STREAM_TIMEOUT_MS)
			: profile === "shortReads"
				? Math.min(options.timeoutMs ?? SHORT_READ_TIMEOUT_MS, SHORT_READ_TIMEOUT_MS)
				: (options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
			throw new DbReadTaskTimeoutError("database read task timed out");
		if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
			throw new DbReadError("DB_READ_INVALID", "Invalid database read deadline");
		const deadlineAt = Math.min(
			startedAt + timeoutMs,
			options.deadlineAt ?? Number.POSITIVE_INFINITY,
		);
		if (deadlineAt <= Date.now())
			throw new DbReadTaskTimeoutError("database read task timed out before admission");
		if (params.kind === "storageScanSessionPreview") assertSessionPreviewBudget(params);
		const identity =
			params.kind === "displayPageMessagesPostgres" ? undefined : getReadDatabaseIdentity(dbPath);
		if (identity) assertReadDatabaseOpen(identity);
		if (params.kind === "domainRead") validateDomainRead(params, diagnostics.meter);
		if (params.kind === "selectRows") validateSelectRows(params, diagnostics.meter);
		if (params.kind === "selectDigestBatch") {
			validateSelectDigestBatch(params, diagnostics.meter);
			if (options.dedupeKey)
				throw new DbReadError("DB_READ_INVALID", "SELECT digest batches cannot share executions");
		}
		if (params.kind === "selectValues" || params.kind === "selectChunks")
			decodeReadBinds(params, diagnostics.meter);
		if (
			(params.kind === "selectChunks" || stream) &&
			(typeof options.onChunk !== "function" || options.dedupeKey)
		) {
			throw new DbReadError("DB_READ_INVALID", "Chunk reads require an independent consumer");
		}
		const bytes = taskParameterBytes(params);
		diagnostics.meter.observe("taskBytes", bytes, DB_READ_QUEUE_MAX_BYTES, "input");
		const s = state();
		const key = options.dedupeKey
			? JSON.stringify([
					identity?.id ?? dbPath,
					params.kind,
					scheduling.taskClass,
					scheduling.shortSource,
					compatibleEphemeral,
					profile,
					options.dedupeKey,
				])
			: undefined;
		let existing = key ? s.inFlight.get(key) : undefined;
		if (existing?.controller.signal.aborted) existing = undefined;
		if (existing) {
			shared = true;
			shareReadFanoutTask(fanout);
			const value = await subscribe(existing, options, deadlineAt);
			status = "completed";
			return value as T;
		}
		s.requestCounter += 1;
		const requestId = `dbr-${Date.now().toString(36)}-${s.requestCounter.toString(36)}`;
		poolDiagnostic = {
			...readPoolTaskLabels(params, options),
			...scheduling,
			requestId,
			startedAt,
			...(sql ? { sql } : {}),
		};
		const request: ReadRequest = {
			dbPath: identity?.path ?? dbPath,
			identity,
			params,
			traceParent: currentSqlTraceSpan()?.id,
			sqlDiagnostic,
			onProgress: options.onProgress,
			onChunk: options.onChunk,
			fresh,
			taskClass: scheduling.taskClass,
			profile,
			compatibleEphemeral,
			diagnostics,
			poolDiagnostic,
			phase: abortContext,
			fanout,
			fanoutExcluded,
		};
		// Track exactly this request's native owner, including one quarantined during startup.
		if (exitTracker) requestOwners.set(requestId, exitTracker);
		let result: unknown;
		try {
			if (key) {
				const controller = new AbortController();
				const entry: SharedRead = {
					request,
					controller,
					promise: Promise.resolve(),
					subscribers: new Set(),
				};
				request.onProgress = (progress) => {
					for (const subscriber of entry.subscribers) {
						try {
							subscriber.progress?.(progress);
						} catch {
							/* isolate observers */
						}
					}
				};
				entry.promise = execute(
					request,
					{ ...options, signal: controller.signal },
					deadlineAt,
					bytes,
					profile,
				).finally(() => {
					if (s.inFlight.get(key) === entry) s.inFlight.delete(key);
				});
				s.inFlight.set(key, entry);
				result = await subscribe(entry, options, deadlineAt);
			} else result = await execute(request, options, deadlineAt, bytes, profile);
		} finally {
			requestOwners.delete(requestId);
		}
		status = "completed";
		return result as T;
	} catch (error) {
		fanoutError = error;
		if (!shared && poolDiagnostic && error instanceof DbReadTaskTimeoutError)
			warnReadPoolTaskTimeout(poolDiagnostic, abortContext.phase);
		if (!shared) {
			try {
				attachDbReadAbortDiagnostics(error, {
					kind: params.kind,
					domainTask: params.kind === "domainRead" ? params.task : undefined,
					phase: abortContext.phase,
					taskId: diagnostics.requestId,
				});
			} catch {
				/* host diagnostics cannot replace the task failure */
			}
		}
		if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
			code = error.code;
		if (!shared && error instanceof DbReadError && error.code === "DB_READ_INVALID") {
			rejected = true;
			try {
				warnReadQueryRejected(
					error,
					"sql" in params ? params.sql : "",
					"params" in params ? params.params : [],
					{
						...options,
						diagnosticSource:
							options.diagnosticSource ??
							(params.kind === "domainRead" ? params.task : params.kind),
					},
				);
			} catch {
				/* diagnostic preparation is best effort */
			}
		}
		throw error;
	} finally {
		finishReadFanoutSpan(fanout, fanoutError);
		if (!shared && !rejected) {
			try {
				if (options.diagnosticContext) {
					const owner = options.diagnosticContext;
					const snapshot = diagnostics.meter.snapshot();
					owner.meter.merge(snapshot.filter((item) => item.phase === "input"));
					for (const item of snapshot) {
						if (item.kind === "rows") {
							owner.meter.observe(
								"rows",
								(owner.observedRows ?? 0) + item.actual,
								SELECT_ROWS_MAX_ROWS,
								"result",
							);
							if (item.actual > item.threshold)
								owner.meter.observe("queryRows", item.actual, item.threshold, item.phase);
						}
						if (item.kind === "resultBytes")
							owner.meter.observe(
								"resultBytes",
								(owner.observedBytes ?? 0) + item.actual,
								SELECT_ROWS_MAX_BYTES,
								"result",
							);
					}
					if (!owner.sqlTemplate && "sql" in params)
						owner.sqlTemplate = boundedReadLogText(params.sql, SELECT_ROWS_MAX_SQL_BYTES);
				} else
					warnReadBudgetExceeded({
						snapshot: diagnostics.meter.snapshot(),
						params,
						source: options.diagnosticSource,
						task: params.kind === "domainRead" ? `domainRead:${params.task}` : params.kind,
						requestId: diagnostics.requestId,
						elapsedMs: Date.now() - startedAt,
						partial: diagnostics.partial || status === "failed",
						status,
						code,
					});
			} catch {
				/* diagnostics cannot turn success into failure */
			}
		}
	}
}
/** Request-local ownership is not a second scheduler and retains no SQL or result data. */
const requestOwners = new Map<string, Set<ReaderOwner>>();

export interface ReaderDrainOptions {
	timeoutMs?: number;
	deadlineAt?: number;
	signal?: AbortSignal;
}
function drainDeadline(options: ReaderDrainOptions): number {
	const deadline = options.deadlineAt ?? Date.now() + (options.timeoutMs ?? 30_000);
	if (!Number.isFinite(deadline))
		throw new DbReadError("DB_READ_INVALID", "Invalid reader drain deadline");
	return deadline;
}
async function awaitReaderDrain(
	work: Promise<unknown>,
	options: ReaderDrainOptions,
): Promise<void> {
	const deadlineAt = drainDeadline(options);
	if (options.signal?.aborted) throw readAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new DbReadTaskTimeoutError(
								"database reader exit was not confirmed before the deadline",
							),
						),
					Math.max(0, deadlineAt - Date.now()),
				);
				if (options.signal) {
					abort = () => reject(readAborted());
					options.signal.addEventListener("abort", abort, { once: true });
					if (options.signal.aborted) abort();
				}
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
	}
}
/** Closes one canonical generation; queued/startup work cannot reopen it after this barrier. */
export async function closeReadDatabase(
	path: string,
	options: ReaderDrainOptions = {},
): Promise<void> {
	const deadlineAt = drainDeadline(options);
	const identity = closeReadDatabaseAdmission(path);
	const s = state();
	const requests = [...s.requests.values()].filter(
		(owned) => owned.request.identity?.id === identity.id,
	);
	for (const owned of requests)
		owned.controller.abort(
			new DbReadError("DB_READ_DATABASE_CLOSED", "database read admission is closed"),
		);
	const work = (async () => {
		await s.upgrade;
		const owners = [...s.owners].filter((owner) => owner.databaseIds.has(identity.id));
		const closing = Promise.all(owners.map((owner) => owner.close()));
		void closing.catch(() => {});
		await Promise.allSettled(requests.map((owned) => owned.settled));
		// A cancelled factory can publish its quarantined owner while unwinding.
		const lateOwners = [...s.owners].filter((owner) => owner.databaseIds.has(identity.id));
		await Promise.all([closing, ...lateOwners.map((owner) => owner.close())]);
		await Promise.all([...owners, ...lateOwners].map((owner) => owner.exited));
		identity.drained = true;
	})();
	await awaitReaderDrain(work, { ...options, deadlineAt });
}
/** Real native-exit barrier; pause/permanent admission closes synchronously before any await. */
export function shutdownDbWorkerPool(
	options: { permanent?: boolean; pause?: boolean } = {},
): Promise<void> {
	const s = state();
	s.permanent ||= options.permanent ?? false;
	s.paused ||= options.pause ?? false;
	invalidateReadDatabaseReadiness();
	if (s.closing) return s.closing;
	const reason = new WorkersUnavailableError("pool_shutdown");
	const pool = s.pool;
	const ephemeral = s.ephemeral;
	const shortReads = s.shortReads;
	const closing = Promise.all([
		s.upgrade,
		pool?.close(reason),
		ephemeral?.close(reason),
		shortReads?.close(reason),
	]).then(async () => {
		await Promise.all([...s.owners].map((owner) => owner.close()));
		if (s.pool === pool) {
			s.pool = undefined;
			s.config = undefined;
		}
		if (s.ephemeral === ephemeral) s.ephemeral = undefined;
		if (s.shortReads === shortReads) s.shortReads = undefined;
		s.inFlight.clear();
		s.closing = undefined;
	});
	s.closing = closing;
	void closing.catch(() => {});
	return closing;
}
export async function drainDbWorkerPool(options: ReaderDrainOptions = {}): Promise<void> {
	const deadlineAt = drainDeadline(options);
	await awaitReaderDrain(shutdownDbWorkerPool({ pause: true }), { ...options, deadlineAt });
}
export function resumeDbWorkerPool(): void {
	const s = state();
	if (s.closing || s.upgrade || s.owners.size)
		throw new DbReadError("DB_READ_BUSY", "database readers are still retiring");
	if (!s.permanent) s.paused = false;
	s.failureReason = null;
	s.spawnFailures = 0;
}
export async function assertDbReadersReady(
	dbPath: string,
	options: Pick<RunReadTaskOptions, "timeoutMs" | "signal"> = {},
): Promise<void> {
	if (workersDisabled() === "worker_unavailable") resumeDbWorkerPool();
	const disabled = workersDisabled();
	if (disabled) throw new WorkersUnavailableError(disabled);
	const timeoutMs = options.timeoutMs ?? 30_000;
	const deadlineAt = Date.now() + timeoutMs;
	const identity = getReadDatabaseIdentity(dbPath);
	identity.ready = false;
	try {
		await runReadTask(
			identity.path,
			{ kind: "domainRead", task: "readerProbe", input: null },
			{ ...options, timeoutMs },
		);
		assertReadDatabaseOpen(identity);
		identity.ready = true;
	} catch (error) {
		const retiring = [...state().owners].filter((owner) => owner.closed);
		if (retiring.length) {
			try {
				await awaitReaderDrain(Promise.all(retiring.map((owner) => owner.exited)), {
					deadlineAt,
					signal: options.signal,
				});
			} catch {
				throw new DbReadError(
					"DB_READ_READER_EXIT_UNCONFIRMED",
					"database reader exit was not confirmed within the readiness deadline",
				);
			}
		}
		throw error;
	}
}
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
export function getDbWorkerAvailability(profileOrPath?: "pool" | "shortReads" | string): {
	available: boolean;
	reason: string | null;
} {
	const isProfile = profileOrPath === "pool" || profileOrPath === "shortReads";
	const profile = isProfile ? (profileOrPath ?? "pool") : "pool";
	const dbPath = isProfile ? undefined : profileOrPath;
	let reason = workersDisabled(profile);
	if (!reason && dbPath !== undefined) {
		const identity = peekReadDatabaseIdentity(dbPath);
		if (!identity) reason = "database_unregistered";
		else if (!identity.open) reason = "database_closing";
		else if (!identity.ready) reason = "database_not_ready";
	}
	return { available: reason === null, reason };
}
/** Read-only scheduling pressure; never constructs a pool, worker or database connection. */
export function getDbReadSchedulingPressure(): {
	available: boolean;
	reason: string | null;
	shouldYield: boolean;
	queued: number;
	normalHeld: number;
	normalCapacity: number;
} {
	const s = state();
	const reason = workersDisabled();
	const stats = s.pool?.stats;
	const shared = stats?.reservation?.shared;
	const queued = stats?.queued ?? 0;
	const normalHeld = shared?.claimed ?? 0;
	let normalCapacity = s.config?.normalCapacity ?? 0;
	if (!reason && !s.config)
		normalCapacity = readSchedulingConfig(getConfiguredConcurrency()).normalCapacity;
	return {
		available: reason === null,
		reason,
		queued,
		normalHeld,
		normalCapacity,
		shouldYield:
			reason === null &&
			Boolean(
				queued > 0 ||
					(shared &&
						(normalHeld >= normalCapacity || shared.retiring > 0 || shared.quarantined > 0)),
			),
	};
}
export function getDbWorkerPoolStats() {
	const s = state();
	const stats = s.pool?.stats;
	const ephemeral = s.ephemeral?.stats;
	const active = (stats?.active ?? 0) + (ephemeral?.active ?? 0);
	const starting = (stats?.starting ?? 0) + (ephemeral?.starting ?? 0);
	return {
		workers: (stats?.workers ?? 0) + (ephemeral?.workers ?? 0),
		busy: [...s.requests.values()].filter(
			({ request }) =>
				request.profile !== "shortReads" &&
				(request.phase.phase === "running" || request.phase.phase === "dispatching"),
		).length,
		queued: (stats?.queued ?? 0) + (ephemeral?.queued ?? 0),
		queuedBytes: (stats?.queuedBytes ?? 0) + (ephemeral?.queuedBytes ?? 0),
		retiring: [...s.owners].filter((owner) => owner.closed).length,
		tracked: s.owners.size,
		inFlight: s.inFlight.size,
		disabledReason: workersDisabled(),
		concurrency: s.config?.concurrency ?? getConfiguredConcurrency(),
		configuration: s.config ?? null,
		main: stats ?? null,
		ephemeral: ephemeral ?? null,
		shortReads: s.shortReads?.stats ?? null,
		activeByClass: stats?.activeByClass ?? { normal: 0, short: 0 },
		queuedByClass: stats?.queuedByClass ?? { normal: 0, short: 0 },
		queuedBytesByClass: stats?.queuedBytesByClass ?? { normal: 0, short: 0 },
		reservation: stats?.reservation ?? null,
		starting,
		claimed: active - starting,
		spawnFailures: s.spawnFailures,
	};
}
if (hotOnce("narrafork.dbWorkerPool.exitHandler")) {
	process.on("exit", () => {
		void shutdownDbWorkerPool({ permanent: true }).catch(() => {});
	});
}
