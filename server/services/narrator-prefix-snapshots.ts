import type { ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { WorkerCleanupError } from "../lib/worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../lib/worker-runtime/pool";
import type {
	PrefixSnapshotGcOptions,
	PrefixSnapshotGcResult,
} from "./narrator-prefix-snapshot-gc";
import {
	freezePrefixValue,
	prefixValueBytes,
	waitForPrefix,
} from "./narrator-prefix-snapshot-values";
import type {
	PrefixSnapshotBackend,
	PrefixSnapshotOperation,
	PrefixSnapshotRequest,
} from "./narrator-prefix-snapshots-worker";
import { createPrefixToolSnapshots } from "./narrator-prefix-tool-snapshots";

export type { PrefixSnapshotBackend } from "./narrator-prefix-snapshots-worker";

export interface PrefixSnapshotStore {
	putPrefixText(text: string, signal?: AbortSignal): Promise<string>;
	getPrefixText(hash: string, signal?: AbortSignal): Promise<string>;
	/** Accepts JSON-compatible data; serialization happens in the worker. */
	putPrefixJson(value: unknown, signal?: AbortSignal): Promise<string>;
	/** Returns a deeply frozen value; cache hits reuse the same reference. */
	getPrefixJson<T>(hash: string, signal?: AbortSignal): Promise<T>;
	putPrefixToolDefinitions(
		definitions: readonly ToolDefinitionSnapshot[],
		signal?: AbortSignal,
	): Promise<string>;
	getPrefixToolDefinitions(hash: string, signal?: AbortSignal): Promise<ToolDefinitionSnapshot[]>;
	withPrefixSnapshotPublication<T>(
		hashes: readonly string[],
		publish: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T>;
	cleanupPrefixSnapshots(
		options?: PrefixSnapshotGcOptions,
		signal?: AbortSignal,
	): Promise<PrefixSnapshotGcResult>;
	/** Stops admission, cancels worker operations and drains existing publication scopes. */
	close(): Promise<void>;
}

const PREFIX_QUEUE_BYTES = 64 * 1024 * 1024;
type PrefixTask = { operation: PrefixSnapshotOperation; value: unknown };

function warnPrefix(message: string, fields?: object): void {
	try {
		console.warn(message, fields);
	} catch {
		// Diagnostics cannot change admission, publication or resource cleanup.
	}
}

/** No serialization or traversal of unknown JSON on the main thread. */
function prefixTaskBytes(operation: PrefixSnapshotOperation, value: unknown): number {
	if (typeof value === "string") return 256 + value.length * 3;
	if (operation === "putJsonBatch" && Array.isArray(value) && value.length <= 64) {
		let bytes = 256;
		for (const item of value) {
			if (!item || typeof item !== "object") return PREFIX_QUEUE_BYTES;
			try {
				bytes += prefixValueBytes(item) * 3;
			} catch {
				return PREFIX_QUEUE_BYTES;
			}
		}
		return bytes;
	}
	if (operation === "getJsonBatch" || operation === "touch" || operation === "lease")
		return 256 + (value as string[]).reduce((bytes, hash) => bytes + hash.length * 3 + 64, 0);
	if (operation === "collect")
		return 512 + prefixTaskBytes("lease", (value as PrefixSnapshotGcOptions).protectedHashes ?? []);
	if (!value || typeof value !== "object") return 256;
	try {
		return 256 + prefixValueBytes(value) * 3;
	} catch {
		// Unknown arbitrarily-large objects reserve the entire waiting budget. This bounds
		// retained unknown payloads without copying/stringifying them merely for admission.
		return PREFIX_QUEUE_BYTES;
	}
}

function validPrefixResult(operation: PrefixSnapshotOperation, value: unknown): boolean {
	const row = (item: unknown): item is Record<string, unknown> =>
		!!item && typeof item === "object" && !Array.isArray(item);
	const size = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
	const hash = (item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
	const json = (item: unknown) =>
		row(item) && Object.hasOwn(item, "json") && item.json !== undefined && size(item.byteSize);
	switch (operation) {
		case "putText":
		case "putJson":
			return hash(value);
		case "getText":
			return typeof value === "string";
		case "getJson":
			return json(value);
		case "putJsonBatch":
			return (
				Array.isArray(value) &&
				value.length <= 64 &&
				value.every((item) => row(item) && hash(item.hash) && size(item.byteSize))
			);
		case "getJsonBatch":
			return Array.isArray(value) && value.length <= 64 && value.every(json);
		case "touch":
			return Array.isArray(value) && value.every((item) => row(item) && hash(item.sha256));
		case "lease":
			return value === true;
		case "collect":
			return (
				row(value) &&
				["assets", "messages", "blocks", "manifests", "sweep", "done"].includes(
					value.phase as string,
				) &&
				size(value.visited) &&
				size(value.deleted)
			);
	}
}

async function createPrefixWorker(
	backend: PrefixSnapshotBackend,
	timeoutMs: number,
	context: WorkerTaskContext,
): Promise<PoolWorker<PrefixTask, unknown>> {
	// Startup belongs to this first operation, not to the next task or its time in the queue.
	const firstDeadline = Date.now() + timeoutMs;
	const { worker, handle } = await connectCompiledWorker(
		compiledWorkerSpecifiers(
			"services/narrator-prefix-snapshots-worker.ts",
			"./narrator-prefix-snapshots-worker.ts",
			import.meta.url,
		),
		{
			signal: context.signal,
			deadlineAt: Math.min(firstDeadline, Date.now() + 5_000),
			timeoutMs: Math.min(5_000, timeoutMs),
			isReady: (message) =>
				!!message &&
				typeof message === "object" &&
				Object.keys(message).length === 1 &&
				(message as { ready?: unknown }).ready === true,
		},
	);
	try {
		context.signal.throwIfAborted();
		worker.unref();
	} catch (error) {
		try {
			await handle.close();
		} catch (cleanup) {
			throw new WorkerCleanupError(handle, cleanup);
		}
		throw error;
	}
	let invalid = false;
	let first = true;
	return {
		get closed() {
			return invalid || handle.closed;
		},
		close: () => handle.close(),
		run({ operation, value }, task) {
			const deadline =
				first && context.requestId === task.requestId ? firstDeadline : Date.now() + timeoutMs;
			first = false;
			return new Promise((resolve, reject) => {
				let settled = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const finish = (error?: unknown, result?: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					task.signal.removeEventListener("abort", onAbort);
					worker.off("message", onMessage);
					worker.off("error", onError);
					worker.off("messageerror", onError);
					worker.off("exit", onExit);
					worker.unref();
					if (error !== undefined) {
						// Even a normal RPC failure invalidates the connection/GC pass. The pool keeps
						// this slot until handle.close confirms exit, before settling or dispatching.
						invalid = true;
						reject(error);
					} else resolve(result);
				};
				const timedOut = () => finish(new AppError("Prefix snapshot operation timed out"));
				const onAbort = () => finish(task.signal.reason);
				const onError = () => finish(new Error("Prefix snapshot worker failed"));
				const onExit = () => finish(new Error("Prefix snapshot worker exited"));
				const onMessage = (message: unknown) => {
					if (!message || typeof message !== "object" || Array.isArray(message)) return onError();
					const reply = message as Record<string, unknown>;
					// A duplicate startup handshake is not a task response. Old RPCs cannot complete
					// a later call, even when a transport emits delayed/duplicate messages.
					if (reply.ready === true && Object.keys(reply).length === 1) return;
					if (typeof reply.requestId !== "string") return onError();
					if (reply.requestId !== task.requestId) return;
					if (Date.now() >= deadline) return timedOut();
					if (Object.keys(reply).length !== 2) return onError();
					if (typeof reply.error === "string") {
						finish(
							new AppError(
								reply.error.startsWith("Prefix snapshot") && reply.error.length <= 256
									? reply.error
									: "Prefix snapshot worker failed",
							),
						);
					} else if (Object.hasOwn(reply, "value") && validPrefixResult(operation, reply.value)) {
						if (
							operation === "putJsonBatch" &&
							(reply.value as unknown[]).length !== (value as unknown[]).length
						)
							return onError();
						if (
							operation === "getJsonBatch" &&
							((reply.value as unknown[]).length > (value as unknown[]).length ||
								(!(reply.value as unknown[]).length && (value as unknown[]).length > 0))
						)
							return onError();
						finish(undefined, reply.value);
					} else onError();
				};
				worker.ref();
				worker.on("message", onMessage);
				worker.on("error", onError);
				worker.on("messageerror", onError);
				worker.on("exit", onExit);
				task.signal.addEventListener("abort", onAbort, { once: true });
				if (task.signal.aborted) return onAbort();
				if (Date.now() >= deadline) return timedOut();
				timer = setTimeout(timedOut, deadline - Date.now());
				try {
					worker.postMessage({
						action: "task",
						requestId: task.requestId,
						backend,
						operation,
						value,
						deadline,
					} satisfies PrefixSnapshotRequest);
				} catch {
					finish(new Error("Prefix snapshot value cannot be cloned"));
				}
			});
		},
	};
}

/** Explicit backend injection keeps tests independent of application bootstrap and real DBs. */
export function createPrefixSnapshotStore(
	backend: PrefixSnapshotBackend,
	options: { cacheBytes?: number; timeoutMs?: number; idleMs?: number } = {},
): PrefixSnapshotStore {
	const cacheBytes = Math.max(0, options.cacheBytes ?? 128 * 1024 * 1024);
	const cache = new Map<string, { value: unknown; bytes: number }>();
	const pendingReads = new Map<string, Promise<unknown>>();
	const weakValues = new Map<string, WeakRef<object>>();
	const activeLeases = new Map<string, number>();
	// Publication owns its protection until publish finally, beyond the lease RPC's pool slot.
	const publications = new Set<Promise<unknown>>();
	let retainedBytes = 0;
	const timeoutMs = options.timeoutMs ?? 120_000;
	let closed = false;
	const pendingObjects = new WeakMap<object, Promise<string>>();
	// A store owns exactly one backend/database actor. Collector temp tables and cursors must
	// never move between otherwise-idle workers. A retired actor always starts a fresh mark pass.
	const identity = Object.freeze({ ...backend });
	const pool = new WorkerPool<PrefixTask, unknown>({
		concurrency: 1,
		maxQueued: 32,
		maxQueuedBytes: PREFIX_QUEUE_BYTES,
		timeoutMs,
		reuse: true,
		idleTimeoutMs: options.idleMs ?? 30_000,
		create: (context) => createPrefixWorker(identity, timeoutMs, context),
		onTaskComplete(timing) {
			if (timing.totalMs >= 1000)
				warnPrefix("Slow prefix snapshot operation", { backend: identity.backend, ...timing });
		},
	});

	function run<T>(
		operation: PrefixSnapshotOperation,
		value: unknown,
		signal?: AbortSignal,
		bytes = prefixTaskBytes(operation, value),
	): Promise<T> {
		if (closed) return Promise.reject(new Error("Prefix snapshot store is closed"));
		return pool.run(
			{ operation, value },
			{
				signal,
				// Preserve the original execution-only budget: waiting is unbounded in time, but
				// bounded in count/bytes. The adapter starts its finite budget on dispatch/create.
				deadlineAt: Number.POSITIVE_INFINITY,
				bytes,
			},
		) as Promise<T>;
	}

	const check = () => {
		if (closed) throw new Error("Prefix snapshot store is closed");
	};
	type CacheKind = "text" | "json" | "tools";
	function peek(hash: string, kind: CacheKind = "json"): unknown {
		const key = `${kind}:${hash}`;
		const entry = cache.get(key);
		if (entry) {
			cache.delete(key);
			cache.set(key, entry);
			return entry.value;
		}
		return weakValues.get(key)?.deref();
	}
	async function remember(
		hash: string,
		value: unknown,
		byteSize: number,
		kind: CacheKind = "json",
	): Promise<void> {
		const key = `${kind}:${hash}`;
		const deadline = Date.now() + timeoutMs;
		const heapBytes = await freezePrefixValue(value, () => {
			check();
			if (Date.now() >= deadline) throw new Error("Prefix snapshot preparation timed out");
		});
		const bytes =
			Math.max(byteSize * 3, heapBytes, typeof value === "string" ? value.length * 2 : 0) + 256;
		if (bytes <= cacheBytes) {
			const previous = cache.get(key);
			if (previous) {
				cache.delete(key);
				retainedBytes -= previous.bytes;
			}
			while (retainedBytes + bytes > cacheBytes) {
				const oldest = cache.entries().next().value;
				if (!oldest) break;
				cache.delete(oldest[0]);
				retainedBytes -= oldest[1].bytes;
			}
			cache.set(key, { value, bytes });
			retainedBytes += bytes;
		}
		if (value && typeof value === "object") {
			weakValues.set(key, new WeakRef(value));
			// Metadata-only budget; values themselves are retained solely by callers/strong LRU.
			while (weakValues.size > 32768) {
				const oldest = weakValues.keys().next().value;
				if (oldest === undefined) break;
				weakValues.delete(oldest);
			}
		}
	}
	async function readJson<T>(hash: string): Promise<T> {
		check();
		const cached = peek(hash);
		if (cached !== undefined) return cached as T;
		const result = await run<{ json: T; byteSize: number }>("getJson", hash);
		await remember(hash, result.json, result.byteSize);
		return result.json;
	}
	async function readText(hash: string, signal?: AbortSignal): Promise<string> {
		check();
		signal?.throwIfAborted();
		const cached = peek(hash, "text");
		if (cached !== undefined) return cached as string;
		const text = await run<string>("getText", hash, signal);
		await remember(hash, text, 0, "text");
		return text;
	}
	function sharedRead<T>(
		kind: CacheKind,
		hash: string,
		read: () => Promise<T>,
		signal?: AbortSignal,
	) {
		if (closed) return Promise.reject<T>(new Error("Prefix snapshot store is closed"));
		if (signal?.aborted) return Promise.reject<T>(signal.reason);
		const key = `${kind}:${hash}`;
		let pending = pendingReads.get(key);
		if (!pending) {
			pending = read().finally(() => pendingReads.delete(key));
			pendingReads.set(key, pending);
		}
		return waitForPrefix(pending as Promise<T>, signal);
	}
	const protect = (hash: string) => {
		activeLeases.set(hash, (activeLeases.get(hash) ?? 0) + 1);
		return () => {
			const count = activeLeases.get(hash) ?? 1;
			if (count === 1) activeLeases.delete(hash);
			else activeLeases.set(hash, count - 1);
		};
	};
	const toolSnapshots = createPrefixToolSnapshots({
		putBatch: (values, signal) => run("putJsonBatch", values, signal),
		getBatch: (hashes) => run("getJsonBatch", hashes),
		// This port receives only the manifest assembled by createPrefixToolSnapshots, never
		// arbitrary caller JSON. Count its fixed-size hashes without visiting definitions.
		putJson: (value, signal) =>
			run(
				"putJson",
				value,
				signal,
				512 + (value as { definitions: string[] }).definitions.length * 256,
			),
		readJson,
		peek,
		remember,
		protect,
		check,
	});

	return {
		putPrefixText: (text, signal) => run<string>("putText", text, signal),
		// Keep text reads independently cancellable down to the worker; the LRU remains shared.
		getPrefixText: readText,
		putPrefixJson(value, signal) {
			if (closed) return Promise.reject(new Error("Prefix snapshot store is closed"));
			// Only coalesce in-flight object identities, never memoize mutable objects after a put.
			// Signalled requests keep independent cancellation. All other puts remain serialized.
			if (signal || !value || typeof value !== "object")
				return run<string>("putJson", value, signal);
			const existing = pendingObjects.get(value);
			if (existing) return existing;
			const result = run<string>("putJson", value).finally(() => pendingObjects.delete(value));
			pendingObjects.set(value, result);
			return result;
		},
		getPrefixJson<T>(hash: string, signal?: AbortSignal): Promise<T> {
			return sharedRead("json", hash, () => readJson<T>(hash), signal);
		},
		...toolSnapshots,
		getPrefixToolDefinitions(hash, signal) {
			if (closed) return Promise.reject(new Error("Prefix snapshot store is closed"));
			return toolSnapshots.getPrefixToolDefinitions(hash, signal);
		},
		withPrefixSnapshotPublication<T>(
			hashes: readonly string[],
			publish: () => Promise<T>,
			signal?: AbortSignal,
		): Promise<T> {
			if (closed) return Promise.reject(new Error("Prefix snapshot store is closed"));
			const publication = (async () => {
				check();
				signal?.throwIfAborted();
				const roots = [...new Set(hashes)];
				for (const hash of roots) activeLeases.set(hash, (activeLeases.get(hash) ?? 0) + 1);
				let timer: ReturnType<typeof setInterval> | undefined;
				let refreshing = false;
				try {
					await run("lease", roots, signal);
					timer = setInterval(() => {
						if (closed || refreshing) return;
						refreshing = true;
						void run("lease", roots)
							.catch(() => warnPrefix("Prefix snapshot publication lease refresh failed"))
							.finally(() => {
								refreshing = false;
							});
					}, 60000);
					timer.unref();
					signal?.throwIfAborted();
					return await publish();
				} finally {
					clearInterval(timer);
					for (const hash of roots) {
						const count = activeLeases.get(hash) ?? 1;
						if (count === 1) activeLeases.delete(hash);
						else activeLeases.set(hash, count - 1);
					}
				}
			})();
			// Register synchronously, before the first awaited lease can enter publish. This is
			// only a drain barrier for existing scopes, not another quota, queue or RPC lifetime.
			publications.add(publication);
			const forget = () => publications.delete(publication);
			void publication.then(forget, forget);
			return publication;
		},
		async cleanupPrefixSnapshots(options: PrefixSnapshotGcOptions = {}, signal?: AbortSignal) {
			const result = await run<PrefixSnapshotGcResult>(
				"collect",
				{
					...options,
					protectedHashes: [...(options.protectedHashes ?? []), ...activeLeases.keys()],
				},
				signal,
			);
			if (result.deleted) {
				cache.clear();
				weakValues.clear();
				retainedBytes = 0;
			}
			return result;
		},
		async close() {
			closed = true;
			cache.clear();
			weakValues.clear();
			retainedBytes = 0;
			// All failures/cancellations, not just GC, retain the lane until actual exit. The
			// lease RPC may already be done while publish still owns a DB transaction/scope.
			// Even a failed native stop cannot reject close before those scopes finish finally.
			const [worker] = await Promise.allSettled([
				pool.close(new Error("Prefix snapshot store is closed")),
				...publications,
			]);
			// Business publication failures still belong to their original callers; drain only
			// proves that their finally ran. A resource cleanup failure keeps the owner closed.
			if (worker.status === "rejected") throw worker.reason;
		},
	};
}

const state = hotSafe("narrator.prefixSnapshots.v2", () => ({
	ownerVersion: 3,
	store: undefined as Promise<PrefixSnapshotStore> | undefined,
	maintenance: undefined as (() => Promise<void>) | undefined,
	closing: undefined as Promise<void> | undefined,
	permanent: false,
}));
function checkDefaultOwner(): void {
	// Old hot-reload owners cannot prove native handle retirement. Reusing their key is
	// essential: a new key (or a zero queued count) would create an overlapping worker.
	if (state.ownerVersion !== 3)
		throw new Error("Prefix snapshot legacy worker owner requires a server restart");
	if (state.permanent || state.closing) throw new Error("Prefix snapshot store is closed");
}
async function defaultStore(): Promise<PrefixSnapshotStore> {
	checkDefaultOwner();
	if (!state.store) {
		state.store = import("../db")
			.then(({ activeDatabaseBackend, activePostgresReadUrl, sqlite }) => {
				if (activeDatabaseBackend === "postgres") {
					if (!activePostgresReadUrl) throw new Error("Prefix snapshot PostgreSQL URL unavailable");
					return createPrefixSnapshotStore({ backend: "postgres", url: activePostgresReadUrl });
				}
				return createPrefixSnapshotStore({ backend: "sqlite", path: sqlite.filename });
			})
			.catch((error) => {
				if (!state.closing) state.store = undefined;
				throw error;
			});
	}
	const store = await state.store;
	checkDefaultOwner();
	return store;
}

/** Stop admission before draining; reopen lazily only after a successful non-permanent close. */
export function closePrefixSnapshotStore(options: { permanent?: boolean } = {}): Promise<void> {
	if (options.permanent) state.permanent = true;
	if (state.closing) return state.closing;
	const stop = state.maintenance;
	state.maintenance = undefined;
	const previous = state.store;
	// Set closing synchronously, before maintenance stop can yield back to a public request.
	const closing = Promise.resolve().then(async () => {
		try {
			if (stop) await stop();
		} finally {
			if (previous) await (await previous).close();
		}
		if (state.ownerVersion !== 3)
			throw new Error("Prefix snapshot legacy worker owner requires a server restart");
		state.store = undefined;
	});
	state.closing = closing;
	void closing.then(
		() => {
			if (state.closing === closing) state.closing = undefined;
		},
		() => {},
	);
	return closing;
}

/** Explicit test reset; a failed close/legacy owner can never be cleared into a second worker. */
export async function resetPrefixSnapshotStoreForTests(): Promise<void> {
	await closePrefixSnapshotStore();
	state.permanent = false;
}

export async function putPrefixText(text: string, signal?: AbortSignal): Promise<string> {
	return (await defaultStore()).putPrefixText(text, signal);
}
export async function getPrefixText(hash: string, signal?: AbortSignal): Promise<string> {
	return (await defaultStore()).getPrefixText(hash, signal);
}
export async function putPrefixJson(value: unknown, signal?: AbortSignal): Promise<string> {
	return (await defaultStore()).putPrefixJson(value, signal);
}
export async function getPrefixJson<T>(hash: string, signal?: AbortSignal): Promise<T> {
	return (await defaultStore()).getPrefixJson<T>(hash, signal);
}
export async function putPrefixToolDefinitions(
	definitions: readonly ToolDefinitionSnapshot[],
	signal?: AbortSignal,
): Promise<string> {
	return (await defaultStore()).putPrefixToolDefinitions(definitions, signal);
}
export async function getPrefixToolDefinitions(
	hash: string,
	signal?: AbortSignal,
): Promise<ToolDefinitionSnapshot[]> {
	return (await defaultStore()).getPrefixToolDefinitions(hash, signal);
}
export async function withPrefixSnapshotPublication<T>(
	hashes: readonly string[],
	publish: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return (await defaultStore()).withPrefixSnapshotPublication(hashes, publish, signal);
}
export async function cleanupPrefixSnapshots(
	options: PrefixSnapshotGcOptions = {},
	signal?: AbortSignal,
): Promise<PrefixSnapshotGcResult> {
	return (await defaultStore()).cleanupPrefixSnapshots(options, signal);
}
/** Testable scheduling seam; stopping awaits cancellation of this GC request only. */
export function createPrefixSnapshotMaintenance(
	collect: (signal: AbortSignal) => Promise<PrefixSnapshotGcResult>,
	options: { intervalMs?: number; startDelayMs?: number } = {},
): () => Promise<void> {
	const controller = new AbortController();
	let busy = false;
	let next = Date.now() + (options.startDelayMs ?? 60000);
	let inFlight: Promise<void> = Promise.resolve();
	const timer = setInterval(() => {
		if (busy || controller.signal.aborted || Date.now() < next) return;
		busy = true;
		inFlight = collect(controller.signal)
			.then((result) => {
				next = Date.now() + (result.phase === "done" ? 5 * 60 * 1000 : 0);
			})
			.catch(() => {
				next = Date.now() + 60000;
				if (!controller.signal.aborted)
					warnPrefix("Prefix snapshot maintenance failed; no incomplete mark pass is swept");
			})
			.finally(() => {
				busy = false;
			});
	}, options.intervalMs ?? 1000);
	timer.unref();
	return async () => {
		clearInterval(timer);
		controller.abort(new Error("Prefix snapshot maintenance stopped"));
		await inFlight;
	};
}
/** Called once by application startup; each tick submits only one bounded worker slice. */
export function startPrefixSnapshotMaintenance(): () => Promise<void> {
	checkDefaultOwner();
	state.maintenance ??= createPrefixSnapshotMaintenance((signal) =>
		cleanupPrefixSnapshots({}, signal),
	);
	const stop = state.maintenance;
	return async () => {
		await stop();
		if (state.maintenance === stop) state.maintenance = undefined;
	};
}
