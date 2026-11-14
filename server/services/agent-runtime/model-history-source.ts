import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import {
	compiledWorkerSpecifiers,
	connectCompiledBunWorker,
	WorkerStartupError,
} from "../../lib/compiled-worker";
import { withDbRetry } from "../../lib/db-resilience";
import {
	assertWorkerBuildId,
	safeSqliteCode,
	workerFailureDetails,
} from "../../lib/db-worker/failure";
import { getConfiguredConcurrency, getDbWorkerAvailability } from "../../lib/db-worker/pool";
import { DB_WORKER_READY_TIMEOUT_MS } from "../../lib/db-worker/protocol";
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { hasRowsOnlyBodies } from "../../lib/narrator-bodies";
import { isCompiledRuntime, RUNTIME_BUILD_ID } from "../../lib/runtime-target";
import { settings } from "../../lib/settings";
import { WorkerCleanupError } from "../../lib/worker-runtime/lifecycle";
import { WorkerPool } from "../../lib/worker-runtime/pool";
import { TaskQueueError } from "../../lib/worker-runtime/queue";
import { modelHistoryManifest } from "./model-history-delta";
import {
	MODEL_HISTORY_MAX_BYTES,
	type ModelHistoryCounters,
	type ModelHistorySource,
	type ModelSourceRowBuilder,
	type ModelToolSourceRow,
	queryModelHistory,
	sqliteHistoryQuery,
} from "./model-history-query";
import {
	type ModelHistorySignature,
	readPostgresModelHistorySignature,
	readSqliteModelHistorySignature,
} from "./model-history-revision";

export const MODEL_HISTORY_MAX_QUEUE = 32;
const GLOBAL_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRY_BYTES = 1024;

type CacheSignature = Pick<ModelHistorySignature, "revision" | "catalogIdentity">;
type Entry = { source: ModelHistorySource; bytes: number; signature: CacheSignature };

/** One generation per database/narrator; only the shared byte budget drives eviction. */
export class ModelHistorySourceCache {
	private entries = new Map<string, Entry>();
	private bytes = 0;
	get size() {
		return this.entries.size;
	}
	get retainedBytes() {
		return this.bytes;
	}
	private delete(key: string): void {
		const entry = this.entries.get(key);
		if (entry) this.bytes -= entry.bytes;
		this.entries.delete(key);
	}
	get(key: string, signature: CacheSignature): ModelHistorySource | undefined {
		const entry = this.entries.get(key);
		if (
			!entry ||
			entry.signature.revision !== signature.revision ||
			entry.signature.catalogIdentity !== signature.catalogIdentity
		)
			return;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.source;
	}
	previous(key: string, catalogIdentity?: string): ModelHistorySource | undefined {
		const entry = this.entries.get(key);
		return entry?.signature.catalogIdentity === catalogIdentity ? entry?.source : undefined;
	}
	set(key: string, source: ModelHistorySource, signature: CacheSignature, bytes: number): void {
		this.delete(key);
		// Even an empty history owns a key, signature and cache bookkeeping.
		bytes +=
			CACHE_ENTRY_BYTES +
			2 * (key.length + signature.revision.length + (signature.catalogIdentity?.length ?? 0));
		if (bytes > GLOBAL_CACHE_BYTES) return;
		while (this.bytes + bytes > GLOBAL_CACHE_BYTES) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
		this.entries.set(key, {
			source,
			bytes,
			signature: { revision: signature.revision, catalogIdentity: signature.catalogIdentity },
		});
		this.bytes += bytes;
	}
	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}
}

// Retire the previous cache representation rather than proving old object ownership again.
const legacyKey = Symbol.for("narrator.modelHistorySource.v1");
const legacy = Reflect.get(globalThis, legacyKey) as { cache: { clear(): void } } | undefined;
legacy?.cache.clear();
Reflect.deleteProperty(globalThis, legacyKey);
const state = hotSafe("narrator.modelHistorySource.v2", () => ({
	cache: new ModelHistorySourceCache(),
	pool: createHistoryPool(),
	restartRequired: false,
	permanent: false,
	progress: new Map<string, ModelHistoryProgress>(),
	loads: 0,
	hits: 0,
	signatureReads: 0,
	lastCounters: null as Readonly<ModelHistoryCounters> | null,
}));
// The old client cleared counters before observing exit and retained no handles.
// Zero legacy counters therefore cannot prove cleanup. Only this one-time owner
// upgrade needs an operator restart; normal startup failures remain retryable.
state.restartRequired ??= !state.pool;
state.pool ??= createHistoryPool();
state.progress ??= new Map();
state.permanent ??= false;
function checkLegacyHistory(): void {
	if (state.restartRequired)
		throw new AppError(
			"Legacy model history worker ownership cannot be verified; process restart required",
			503,
			"MODEL_HISTORY_WORKER_RESTART_REQUIRED",
		);
}
// Re-evaluation may change source ownership/types; keep admission state, never old source objects.
state.cache.clear();
state.cache = new ModelHistorySourceCache();

/**
 * Whether block-format bodies are read from their rows: with `narratorBlocks.read`, or while
 * the database holds rows-only envelopes, which have nothing else to read.
 */
function blockBodies(sqlite: Database): boolean {
	return settings.narratorBlocks.read || hasRowsOnlyBodies(sqlite);
}

/** Order of a message's ledger rows: creation (call) order, ids breaking ties. */
function compareToolRows(a: ModelToolSourceRow, b: ModelToolSourceRow): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function modelHistorySourceStats() {
	return {
		loads: state.loads,
		hits: state.hits,
		signatureReads: state.signatureReads,
		cacheEntries: state.cache.size,
		cacheBytes: state.cache.retainedBytes,
		workers: state.pool.stats.active,
		queued: state.pool.stats.queued,
		lastCounters: state.lastCounters,
	};
}
export function clearModelHistorySourceCacheForTest(): void {
	state.cache.clear();
}

export type ModelHistoryBackend =
	| { backend: "sqlite"; sqlite: Database }
	| { backend: "postgres"; sql: SQL; url: string };
export type LoadModelHistoryOptions = {
	limit?: number;
	signal?: AbortSignal;
};

/** Explicit test/development ownership probe; production source reads never walk/freeze the graph. */
export async function freezeModelHistorySource(
	source: object,
	signal?: AbortSignal,
): Promise<void> {
	type Frame = { value: object; keys: string[] | null; length: number; index: number };
	const stack: Frame[] = [];
	const seen = new WeakSet<object>();
	const push = (value: object) => {
		if (seen.has(value)) return;
		seen.add(value);
		Object.freeze(value);
		// A shallow-frozen parent does not prove its children are frozen. Arrays need no
		// Object.values/Object.keys copy: visit primitive slots with an index and yield too.
		const keys = Array.isArray(value) ? null : Object.keys(value);
		stack.push({ value, keys, length: keys?.length ?? (value as unknown[]).length, index: 0 });
	};
	push(source);
	let visitedSlots = 0;
	while (stack.length) {
		const frame = stack[stack.length - 1];
		if (frame.index >= frame.length) {
			stack.pop();
			continue;
		}
		const key = frame.keys ? frame.keys[frame.index++] : frame.index++;
		const value = (frame.value as Record<string | number, unknown>)[key];
		if (value && typeof value === "object") push(value);
		if (++visitedSlots >= 1000) {
			visitedSlots = 0;
			signal?.throwIfAborted();
			await Bun.sleep(0);
		}
	}
	signal?.throwIfAborted();
}

/**
 * The embedded worker key inside a compiled binary depends on the build layout: a build whose
 * entries share the `server/` root folds the prefix away, while a main entry outside `server/`
 * keeps the full path. Candidates are probed; the winner is cached in state.
 */
export function modelHistoryWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"services/agent-runtime/model-history-worker.ts",
		"./model-history-worker.ts",
		moduleUrl,
		compiled,
	);
}

/** Sentinel distinguishing a worker that never started from one that failed mid-query. */
class HistoryWorkerStartupError extends AppError {}

function checkHistoryMaintenance(): void {
	if (getDbWorkerAvailability().reason === "pool_shutdown")
		throw new AppError(
			"Model history workers paused for database maintenance",
			503,
			"MODEL_HISTORY_WORKER_PAUSED",
		);
}
function checkWorkerEnabled(): void {
	checkLegacyHistory();
	checkHistoryMaintenance();
	if (process.env.NARRAFORK_DB_WORKER === "off" || getConfiguredConcurrency() === 0)
		throw new AppError(
			"Model history read-only worker disabled",
			503,
			"MODEL_HISTORY_WORKER_DISABLED",
		);
}

function logHistoryWorkerFailure(
	phase: "create" | "ready" | "dispatch" | "run" | "close" | "message" | "read",
	error: unknown,
	diagnostic?: unknown,
): void {
	try {
		const local = workerFailureDetails(error, phase === "create" || phase === "ready");
		// Read only protocol fields; nested errors and all other received fields are untrusted.
		const received = diagnostic as { errorType?: unknown; code?: unknown } | null | undefined;
		const remote = workerFailureDetails(
			{ errorType: received?.errorType, code: safeSqliteCode(received) },
			false,
		);
		logger.error("Model history worker failure", {
			entry: "model-history-worker",
			phase,
			buildId: RUNTIME_BUILD_ID,
			errorType: diagnostic === undefined ? local.errorType : remote.errorType,
			code: local.code ?? remote.code,
		});
	} catch {
		/* diagnostics must not prevent cleanup */
	}
}

type ModelHistoryProgress = {
	phase: "signature" | "cache" | "queue" | "worker" | "read";
	refs: number;
	toolRows: number;
	sourceBytes?: number;
};

type HistoryRead = {
	backend: ModelHistoryBackend;
	narratorId: string;
	options: LoadModelHistoryOptions;
	versioned: boolean;
	progress: ModelHistoryProgress;
	previous?: { source: ModelHistorySource; catalogIdentity?: string };
};
type HistoryReadResult = { source: ModelHistorySource; signature?: ModelHistorySignature };
function createHistoryPool(): WorkerPool<HistoryRead, HistoryReadResult> {
	return new WorkerPool<HistoryRead, HistoryReadResult>({
		concurrency: 2,
		maxQueued: MODEL_HISTORY_MAX_QUEUE,
		maxQueuedBytes: 64 * 1024 * 1024,
		reuse: false,
		async create(context) {
			checkWorkerEnabled();
			const progress = state.progress.get(context.requestId);
			if (progress) progress.phase = "worker";
			let connected: Awaited<ReturnType<typeof connectCompiledBunWorker>>;
			try {
				connected = await connectCompiledBunWorker(modelHistoryWorkerSpecifiers(), {
					signal: context.signal,
					deadlineAt: Math.min(context.deadlineAt, Date.now() + DB_WORKER_READY_TIMEOUT_MS),
					timeoutMs: DB_WORKER_READY_TIMEOUT_MS,
					sendPing: false,
					isReady(message) {
						try {
							if ((message as { type?: string })?.type !== "ready")
								throw new Error("Missing ready handshake");
							assertWorkerBuildId((message as { buildId?: string }).buildId);
							checkWorkerEnabled();
							return true;
						} catch (error) {
							logHistoryWorkerFailure("ready", error);
							throw new AppError(
								"Model history worker readiness validation failed",
								500,
								"MODEL_HISTORY_READY_INVALID",
							);
						}
					},
				});
			} catch (error) {
				if (error instanceof WorkerCleanupError || context.signal.aborted) throw error;
				const cause = error instanceof Error ? error.cause : undefined;
				const phase =
					cause instanceof WorkerStartupError
						? "ready"
						: cause instanceof AppError
							? "ready"
							: "create";
				logHistoryWorkerFailure(phase, cause ?? error);
				if (cause instanceof AppError) throw cause;
				if (cause instanceof WorkerStartupError && cause.code === "EXITED")
					throw new HistoryWorkerStartupError(
						"Model history read-only worker closed before completion",
					);
				throw new HistoryWorkerStartupError(
					cause instanceof WorkerStartupError && cause.code === "TIMEOUT"
						? "Model history worker readiness timed out"
						: "Model history read-only worker failed to start",
				);
			}
			const { worker, handle } = connected;
			return {
				get closed() {
					return handle.closed;
				},
				close: () => handle.close(),
				run: ({ backend, narratorId, options, versioned, progress, previous }, task) =>
					streamHistory(
						worker,
						backend,
						narratorId,
						{ ...options, signal: task.signal },
						versioned,
						progress,
						previous,
					),
			};
		},
	});
}

/** Permanent production close: cache hits and in-memory fixtures cannot bypass it. */
export async function closeModelHistoryWorkers(): Promise<void> {
	state.permanent = true;
	await state.pool.close();
	checkLegacyHistory();
}
export async function pauseModelHistorySourceWorkers(): Promise<void> {
	await state.pool.close();
	checkLegacyHistory();
}
export async function resumeModelHistorySourceWorkers(): Promise<void> {
	if (state.permanent) throw new AppError("Model history workers are permanently closed");
	const pool = state.pool;
	if (!pool.stats.closed) return;
	await pool.close();
	if (state.permanent) throw new AppError("Model history workers are permanently closed");
	checkLegacyHistory();
	if (state.pool === pool) state.pool = createHistoryPool();
}
export async function resetModelHistoryWorkersForTest(): Promise<void> {
	await state.pool.close();
	checkLegacyHistory();
	state.permanent = false;
	state.pool = createHistoryPool();
	state.cache.clear();
}

async function readWorker(
	backend: ModelHistoryBackend,
	narratorId: string,
	options: LoadModelHistoryOptions,
	versioned: boolean,
	progress: ModelHistoryProgress,
	previous?: { source: ModelHistorySource; catalogIdentity?: string },
): Promise<HistoryReadResult> {
	progress.phase = "queue";
	const requestId = generateId();
	state.progress.set(requestId, progress);
	try {
		return await state.pool.run(
			{ backend, narratorId, options, versioned, progress, previous },
			{
				requestId,
				signal: options.signal,
				// The existing read budget is caller cancellation, not a new 30-second cap.
				deadlineAt: Number.MAX_SAFE_INTEGER,
				bytes: 2 * narratorId.length + (previous?.source.counters.sourceBytes ?? 0),
			},
		);
	} catch (error) {
		if (error instanceof WorkerCleanupError) throw error;
		if (options.signal?.aborted) {
			if (options.signal.reason instanceof Error && options.signal.reason.name !== "AbortError")
				throw options.signal.reason;
			throw new AppError("Model history preparation cancelled");
		}
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
			throw new AppError(
				"Model history worker queue is full",
				503,
				"MODEL_HISTORY_WORKER_OVERLOADED",
			);
		throw error;
	} finally {
		state.progress.delete(requestId);
	}
}

async function streamHistory(
	worker: Worker,
	backend: ModelHistoryBackend,
	narratorId: string,
	options: LoadModelHistoryOptions,
	versioned: boolean,
	progress: ModelHistoryProgress,
	previous?: { source: ModelHistorySource; catalogIdentity?: string },
): Promise<HistoryReadResult> {
	checkWorkerEnabled();
	options.signal?.throwIfAborted();
	progress.phase = "worker";
	progress.refs = 0;
	progress.toolRows = 0;
	return new Promise<{
		source: ModelHistorySource;
		signature?: ModelHistorySignature;
	}>((resolve, reject) => {
		const messages: ModelSourceRowBuilder[] = [];
		const byId = new Map<string, ModelSourceRowBuilder>();
		const previousById = new Map(previous?.source.messages.map((row) => [row.id, row]));
		const previousTools = new Map(
			previous?.source.messages.flatMap((row) =>
				row.toolCalls.map((tool) => [tool.id, tool] as const),
			),
		);
		let finished = false;
		const finish = (
			error?: Error,
			counters?: ModelHistoryCounters,
			compactSeq?: number | null,
			signature?: ModelHistorySignature,
		) => {
			if (finished) return;
			finished = true;
			options.signal?.removeEventListener("abort", abort);
			worker.onmessage = null;
			worker.onerror = null;
			worker.removeEventListener("close", onClose);
			worker.removeEventListener("messageerror", onMessageError);
			if (error || !counters)
				reject(error ?? new AppError("Model history worker did not complete"));
			else {
				// Call order, not random-id order: a call only kept in the ledger is
				// replayed where it was made, and renames follow the same sequence.
				for (const row of messages) row.toolCalls.sort(compareToolRows);
				resolve({ source: { messages, counters, compactSeq }, signature });
			}
		};
		const abort = () => finish(new AppError("Model history preparation cancelled"));
		const send = (message: unknown) => {
			try {
				worker.postMessage(message);
			} catch (error) {
				logHistoryWorkerFailure("dispatch", error);
				finish(new AppError("Model history read-only worker dispatch failed"));
			}
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		worker.onerror = (event) => {
			logHistoryWorkerFailure("run", event);
			finish(new AppError("Model history read-only worker failed"));
		};
		const onClose = () => {
			const error = new AppError("Model history read-only worker closed before completion");
			logHistoryWorkerFailure("close", error);
			finish(error);
		};
		const onMessageError = (event: Event) => {
			logHistoryWorkerFailure("message", event);
			finish(new AppError("Model history read-only worker message failed"));
		};
		worker.addEventListener("close", onClose);
		worker.addEventListener("messageerror", onMessageError);
		worker.onmessage = (event) => {
			try {
				if (finished) return;
				if (options.signal?.aborted) return abort();
				if (event.data.type === "page") {
					for (const row of event.data.rows as ModelSourceRowBuilder[]) {
						messages.push(row);
						byId.set(row.id, row);
					}
					send({ type: "ack" });
				} else if (event.data.type === "tools") {
					for (const { messageId, ...tool } of event.data.rows as Array<
						ModelToolSourceRow & { messageId: string }
					>)
						byId.get(messageId)?.toolCalls.push(tool);
					send({ type: "ack" });
				} else if (event.data.type === "reuseBodies") {
					for (const id of event.data.ids as string[]) {
						const old = previousById.get(id);
						if (!old) return finish(new AppError("Model history delta source unavailable"));
						const row = { ...old, toolCalls: [] };
						messages.push(row);
						byId.set(id, row);
					}
					send({ type: "ack" });
				} else if (event.data.type === "reuseTools") {
					for (const { id, messageId } of event.data.rows as Array<{
						id: string;
						messageId: string;
					}>) {
						const old = previousTools.get(id);
						if (!old) return finish(new AppError("Model history delta tool source unavailable"));
						byId.get(messageId)?.toolCalls.push(old);
					}
					send({ type: "ack" });
				} else if (event.data.type === "order") {
					if (event.data.reset) messages.length = 0;
					for (const id of event.data.ids as string[])
						messages.push(byId.get(id) as ModelSourceRowBuilder);
					send({ type: "ack" });
				} else if (event.data.type === "done")
					finish(undefined, event.data.counters, event.data.compactSeq, event.data.signature);
				// The worker only sends its fixed public error messages, never raw driver errors.
				else if (event.data.type === "error") {
					const code = backend.backend === "sqlite" ? safeSqliteCode(event.data) : undefined;
					const error = new AppError(event.data.message, 500, code ?? "MODEL_HISTORY_READ_FAILED");
					logHistoryWorkerFailure("read", error, event.data.diagnostic);
					finish(error);
				}
				progress.refs = messages.length;
				if (event.data.type === "tools" || event.data.type === "reuseTools")
					progress.toolRows += event.data.rows.length;
			} catch (error) {
				logHistoryWorkerFailure("message", error);
				// Request preparation also performs bounded SQLite metadata reads. Preserve
				// their result code so the outer whole-read retry can release this slot first.
				const code = backend.backend === "sqlite" ? safeSqliteCode(error) : undefined;
				finish(
					new AppError(
						"Model history read-only worker message failed",
						500,
						code ?? "MODEL_HISTORY_READ_FAILED",
					),
				);
			}
		};
		if (options.signal?.aborted) return abort();
		const sendRequest = () =>
			send({
				narratorId,
				limit: options.limit,
				maxBytes: MODEL_HISTORY_MAX_BYTES,
				versioned,
				bodiesFromBlocks: backend.backend === "sqlite" && blockBodies(backend.sqlite),
				previous: previous ? modelHistoryManifest(previous.source) : undefined,
				previousCatalogIdentity: previous?.catalogIdentity,
				...(backend.backend === "sqlite"
					? { backend: "sqlite", path: backend.sqlite.filename }
					: { backend: "postgres", url: backend.url }),
			});
		try {
			sendRequest();
		} catch (error) {
			const code = backend.backend === "sqlite" ? safeSqliteCode(error) : undefined;
			finish(
				new AppError(
					"Model history read-only worker message failed",
					500,
					code ?? "MODEL_HISTORY_READ_FAILED",
				),
			);
		}
	});
}

async function readModelHistorySource(
	backend: ModelHistoryBackend,
	narratorId: string,
	options: LoadModelHistoryOptions,
	progress: ModelHistoryProgress,
): Promise<ModelHistorySource> {
	// A read already in flight at hot reload can finish, but only populate its retired cache.
	const cache = state.cache;
	const check = () => {
		options.signal?.throwIfAborted();
		checkLegacyHistory();
		checkHistoryMaintenance();
		if (state.pool.stats.closed)
			throw new AppError("Model history workers are closed", 503, "MODEL_HISTORY_WORKER_CLOSED");
	};
	check();
	const signature = async () => {
		state.signatureReads++;
		return backend.backend === "sqlite"
			? readSqliteModelHistorySignature(backend.sqlite, narratorId)
			: readPostgresModelHistorySignature(backend.sql, narratorId, { signal: options.signal });
	};
	const before = await signature();
	check();
	const identity =
		backend.backend === "sqlite" ? backend.sqlite.filename : `postgres:${Bun.hash(backend.url)}`;
	// An in-memory connection has no cross-thread read-only identity; never cache its shared name.
	const inMemory = backend.backend === "sqlite" && (identity === ":memory:" || !identity);
	const key = `${identity}\u0000${narratorId}`;
	const cacheable = before.trusted && !inMemory && options.limit == null;
	if (cacheable) {
		const cached = cache.get(key, before);
		if (cached) {
			state.hits++;
			progress.phase = "cache";
			progress.refs = cached.counters.refs;
			progress.toolRows = cached.counters.toolRows;
			progress.sourceBytes = cached.counters.sourceBytes;
			return cached;
		}
	}
	checkWorkerEnabled();
	state.loads++;
	// Test-only in-memory fixtures cannot be opened by a worker. The query's metadata preflight
	// still bounds rows/bytes; production file/PG reads NEVER fall back to inline JSON parsing.
	// A trigger reinstall can leave row counters unchanged: only reuse within the same catalog.
	const candidate = cacheable ? cache.previous(key, before.catalogIdentity) : undefined;
	const previous = candidate
		? { source: candidate, catalogIdentity: before.catalogIdentity }
		: undefined;
	let source: ModelHistorySource;
	// The worker labels its rows with the signature read inside the same snapshot. A write
	// landing during the read is simply newer than this snapshot, never a reason to fail.
	let after = before;
	if (inMemory && backend.backend === "sqlite") {
		progress.phase = "read";
		source = await queryModelHistory(sqliteHistoryQuery(backend.sqlite), {
			narratorId,
			limit: options.limit,
			signal: options.signal,
			maxBytes: 1024 * 1024,
			inlineRowBytes: 64 * 1024,
			versioned: before.trusted,
			bodiesFromBlocks: blockBodies(backend.sqlite),
		});
	} else {
		let loaded: Awaited<ReturnType<typeof readWorker>>;
		try {
			loaded = await readWorker(backend, narratorId, options, before.trusted, progress, previous);
		} catch (error) {
			if (
				!previous ||
				!(error instanceof Error) ||
				error.message !== "Model history delta structure changed"
			)
				throw error;
			// Ref deletion/reorder/COW, compact, segment/lazy range changes: one full rebuild,
			// preserving cancellation. No partial delta or indefinite retries are accepted.
			loaded = await readWorker(backend, narratorId, options, before.trusted, progress);
		}
		source = loaded.source;
		after = loaded.signature ?? before;
	}
	options.signal?.throwIfAborted();
	// Rows were read with or without revision columns according to `before`.
	if (before.trusted !== after.trusted)
		throw new AppError("Model history revision trust changed during preparation; request not sent");
	progress.refs = source.counters.refs;
	progress.toolRows = source.counters.toolRows;
	progress.sourceBytes = source.counters.sourceBytes;
	check();
	state.lastCounters = source.counters;
	if (cacheable && after.trusted) cache.set(key, source, after, source.counters.preparedBytes);
	return source;
}

/** Slow reads are diagnostic, never a reason to stop preparing a valid conversation. */
export async function loadModelHistorySource(
	backend: ModelHistoryBackend,
	narratorId: string,
	options: LoadModelHistoryOptions = {},
): Promise<ModelHistorySource> {
	const startedAt = Date.now();
	const progress: ModelHistoryProgress = { phase: "signature", refs: 0, toolRows: 0 };
	let warned = false;
	const warnIfSlow = () => {
		const elapsedMs = Date.now() - startedAt;
		if (warned || elapsedMs < 10_000) return;
		warned = true;
		try {
			logger.warn("Slow model history preparation", {
				narratorId,
				backend: backend.backend,
				elapsedMs,
				...progress,
				workers: state.pool.stats.active,
				queued: state.pool.stats.queued,
			});
		} catch {
			// A diagnostic sink must not change the result of a history read.
		}
	};
	const timer = setTimeout(warnIfSlow, 10_000);
	timer.unref();
	try {
		const read = () => {
			progress.phase = "signature";
			return readModelHistorySource(backend, narratorId, options, progress);
		};
		return backend.backend === "sqlite"
			? await withDbRetry(read, {
					label: "model_history_read",
					maxRetries: 3,
					signal: options.signal,
					retryLegacyMessages: false,
				})
			: await read();
	} finally {
		clearTimeout(timer);
		// Also covers synchronous work that delayed the timer until after completion.
		warnIfSlow();
	}
}
