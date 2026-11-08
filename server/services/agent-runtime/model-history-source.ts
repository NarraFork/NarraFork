import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import { compiledWorkerSpecifiers } from "../../lib/compiled-worker";
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import { logger } from "../../lib/logger";
import { hasRowsOnlyBodies } from "../../lib/narrator-bodies";
import { isCompiledRuntime } from "../../lib/runtime-target";
import { settings } from "../../lib/settings";
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
	workers: 0,
	workerWaiters: [] as Array<() => void>,
	loads: 0,
	hits: 0,
	signatureReads: 0,
	lastCounters: null as Readonly<ModelHistoryCounters> | null,
	workerSpecifier: null as string | null,
}));
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
		workers: state.workers,
		queued: state.workerWaiters.length,
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
const WORKER_STARTUP_ERROR = new AppError("Model history read-only worker failed to start");

type ModelHistoryProgress = {
	phase: "signature" | "cache" | "queue" | "worker" | "read";
	refs: number;
	toolRows: number;
	sourceBytes?: number;
};

/** Hand a released slot directly to the next reader instead of polling every millisecond. */
function acquireWorkerSlot(signal?: AbortSignal): Promise<() => void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const start = () => {
			signal?.removeEventListener("abort", abort);
			state.workers++;
			resolve(() => {
				state.workers--;
				state.workerWaiters.shift()?.();
			});
		};
		const abort = () => {
			const index = state.workerWaiters.indexOf(start);
			if (index !== -1) state.workerWaiters.splice(index, 1);
			signal?.removeEventListener("abort", abort);
			reject(signal?.reason);
		};
		if (state.workers < 2) start();
		else {
			state.workerWaiters.push(start);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		}
	});
}

async function readWorker(
	backend: ModelHistoryBackend,
	narratorId: string,
	options: LoadModelHistoryOptions,
	versioned: boolean,
	progress: ModelHistoryProgress,
	previous?: { source: ModelHistorySource; catalogIdentity?: string },
): Promise<{ source: ModelHistorySource; signature?: ModelHistorySignature }> {
	progress.phase = "queue";
	const release = await acquireWorkerSlot(options.signal);
	try {
		options.signal?.throwIfAborted();
		progress.phase = "worker";
		progress.refs = 0;
		progress.toolRows = 0;
		const candidates = state.workerSpecifier
			? [state.workerSpecifier]
			: modelHistoryWorkerSpecifiers();
		let lastError: Error | undefined;
		for (const specifier of candidates) {
			options.signal?.throwIfAborted();
			// Global Worker: a file: href resolves inside $bunfs. node:worker_threads would reject it.
			const worker = new Worker(specifier);
			// A module-load failure surfaces as onerror with no message at all; a running
			// worker always communicates before dying. That difference gates the probe.
			let received = false;
			try {
				const loaded = await new Promise<{
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
						worker.terminate();
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
						} catch {
							finish(new AppError("Model history read-only worker dispatch failed"));
						}
					};
					options.signal?.addEventListener("abort", abort, { once: true });
					worker.onerror = () =>
						finish(
							received
								? new AppError("Model history read-only worker failed")
								: WORKER_STARTUP_ERROR,
						);
					// Bun emits close even for an early, otherwise silent exit. finish marks
					// completion before terminate, so our own shutdown cannot reject success.
					worker.addEventListener("close", () =>
						finish(new AppError("Model history read-only worker closed before completion")),
					);
					worker.addEventListener("messageerror", () =>
						finish(new AppError("Model history read-only worker message failed")),
					);
					worker.onmessage = (event) => {
						if (finished) return;
						received = true;
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
								if (!old)
									return finish(new AppError("Model history delta tool source unavailable"));
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
						else if (event.data.type === "error") finish(new AppError(event.data.message));
						progress.refs = messages.length;
						if (event.data.type === "tools" || event.data.type === "reuseTools")
							progress.toolRows += event.data.rows.length;
					};
					if (options.signal?.aborted) return abort();
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
				});
				state.workerSpecifier = specifier;
				return loaded;
			} catch (error) {
				// Only a candidate that never started is probed against the next path shape;
				// a worker that died mid-query must surface its real error unchanged.
				if (error !== WORKER_STARTUP_ERROR || specifier === candidates.at(-1)) throw error as Error;
				lastError = error as Error;
			}
		}
		throw lastError ?? new AppError("Model history read-only worker failed");
	} finally {
		release();
	}
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
				workers: state.workers,
				queued: state.workerWaiters.length,
			});
		} catch {
			// A diagnostic sink must not change the result of a history read.
		}
	};
	const timer = setTimeout(warnIfSlow, 10_000);
	timer.unref();
	try {
		return await readModelHistorySource(backend, narratorId, options, progress);
	} finally {
		clearTimeout(timer);
		// Also covers synchronous work that delayed the timer until after completion.
		warnIfSlow();
	}
}
