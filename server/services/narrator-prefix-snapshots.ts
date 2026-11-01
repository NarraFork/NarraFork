import type { Worker } from "node:worker_threads";
import type { ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { hotSafe } from "../lib/hot-safe";
import type {
	PrefixSnapshotGcOptions,
	PrefixSnapshotGcResult,
} from "./narrator-prefix-snapshot-gc";
import { freezePrefixValue, waitForPrefix } from "./narrator-prefix-snapshot-values";
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
	/** Releases this store's worker/cache; outstanding operations reject. */
	close(): Promise<void>;
}

/** Explicit backend injection keeps tests independent of application bootstrap and real DBs. */
export function createPrefixSnapshotStore(
	backend: PrefixSnapshotBackend,
	options: { cacheBytes?: number; timeoutMs?: number; idleMs?: number } = {},
): PrefixSnapshotStore {
	const cacheBytes = Math.max(0, options.cacheBytes ?? 128 * 1024 * 1024);
	const jsonCache = new Map<string, { value: unknown; bytes: number }>();
	const pendingReads = new Map<string, Promise<unknown>>();
	const weakValues = new Map<string, WeakRef<object>>();
	const activeLeases = new Map<string, number>();
	let retainedJsonBytes = 0;
	const timeoutMs = options.timeoutMs ?? 120_000;
	let worker: Worker | undefined;
	let receive: ((message: { error?: string; value?: unknown }) => void) | undefined;
	let specifier: string | undefined;
	let tail: Promise<unknown> = Promise.resolve();
	let idle: ReturnType<typeof setTimeout> | undefined;
	let queued = 0;
	let closed = false;
	let retiring: Promise<unknown> = Promise.resolve();
	const aborters = new Set<() => void>();
	const pendingObjects = new WeakMap<object, Promise<string>>();
	const retire = () => {
		const previous = worker;
		worker = undefined;
		if (previous) {
			previous.on("error", () => {});
			retiring = Promise.all([retiring, previous.terminate()]);
		}
	};

	function run<T>(operation: PrefixSnapshotOperation, value: unknown, signal?: AbortSignal) {
		if (closed) return Promise.reject<T>(new Error("Prefix snapshot store is closed"));
		if (signal?.aborted) return Promise.reject<T>(signal.reason);
		clearTimeout(idle);
		queued++;
		let started = 0;
		const controller = new AbortController();
		const promise = new Promise<T>((resolve, reject) => {
			let finished = false;
			let active = false;
			let cleanup = () => {};
			const finish = (error?: unknown, result?: T) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				aborters.delete(close);
				cleanup();
				if (error !== undefined) {
					controller.abort(error);
					if (active) retire();
					reject(error);
				} else resolve(result as T);
			};
			const abort = () => finish(signal?.reason ?? new Error("Prefix snapshot cancelled"));
			const close = () => finish(new Error("Prefix snapshot store is closed"));
			let timer: ReturnType<typeof setTimeout> | undefined;
			aborters.add(close);
			signal?.addEventListener("abort", abort, { once: true });
			const execute = async () => {
				if (finished) return;
				started = Date.now();
				timer = setTimeout(
					() => finish(new Error("Prefix snapshot operation timed out")),
					timeoutMs,
				);
				active = true;
				try {
					if (!worker) {
						const connected = await connectCompiledWorker(
							specifier
								? [specifier]
								: compiledWorkerSpecifiers(
										"services/narrator-prefix-snapshots-worker.ts",
										"./narrator-prefix-snapshots-worker.ts",
										import.meta.url,
									),
							{ signal: controller.signal },
						);
						if (finished) {
							void connected.worker.terminate();
							return;
						}
						worker = connected.worker;
						specifier = connected.specifier;
						const connectedThread = worker;
						worker.on("message", (message) => {
							if (worker === connectedThread) receive?.(message);
						});
						worker.on("error", () => {
							if (worker === connectedThread) receive?.({ error: "Prefix snapshot worker failed" });
						});
						worker.on("exit", () => {
							if (worker === connectedThread) {
								if (receive) receive({ error: "Prefix snapshot worker exited" });
								else worker = undefined;
							}
						});
					}
					const thread = worker;
					thread.ref();
					await new Promise<void>((done) => {
						receive = (message) =>
							finish(
								Date.now() >= started + timeoutMs
									? new Error("Prefix snapshot operation timed out")
									: message.error
										? new Error(message.error)
										: undefined,
								message.value as T,
							);
						cleanup = () => {
							receive = undefined;
							thread.unref();
							done();
						};
						try {
							thread.postMessage({
								action: "task",
								backend,
								operation,
								value,
								cacheBytes: Math.min(cacheBytes, 16 * 1024 * 1024),
								deadline: started + timeoutMs,
							} satisfies PrefixSnapshotRequest);
						} catch {
							finish(new Error("Prefix snapshot value cannot be cloned"));
						}
					});
				} catch (error) {
					finish(error);
				} finally {
					active = false;
				}
			};
			tail = tail.then(execute).finally(() => {
				queued--;
				if (!queued && !closed) {
					idle = setTimeout(retire, options.idleMs ?? 30_000);
					idle.unref();
				}
				const elapsedMs = Date.now() - started;
				if (started && elapsedMs >= 1000)
					console.warn("Slow prefix snapshot operation", { operation, elapsedMs });
			});
		});
		return promise;
	}

	const check = () => {
		if (closed) throw new Error("Prefix snapshot store is closed");
	};
	function peek(hash: string): unknown {
		const entry = jsonCache.get(hash);
		if (entry) {
			jsonCache.delete(hash);
			jsonCache.set(hash, entry);
			return entry.value;
		}
		return weakValues.get(hash)?.deref();
	}
	async function remember(hash: string, value: unknown, byteSize: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const heapBytes = await freezePrefixValue(value, () => {
			check();
			if (Date.now() >= deadline) throw new Error("Prefix snapshot preparation timed out");
		});
		const bytes = Math.max(byteSize * 3, heapBytes) + 256;
		if (bytes <= cacheBytes) {
			const previous = jsonCache.get(hash);
			if (previous) {
				jsonCache.delete(hash);
				retainedJsonBytes -= previous.bytes;
			}
			while (retainedJsonBytes + bytes > cacheBytes) {
				const oldest = jsonCache.entries().next().value;
				if (!oldest) break;
				jsonCache.delete(oldest[0]);
				retainedJsonBytes -= oldest[1].bytes;
			}
			jsonCache.set(hash, { value, bytes });
			retainedJsonBytes += bytes;
		}
		if (value && typeof value === "object") {
			weakValues.set(hash, new WeakRef(value));
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
	const touch = async (hashes: string[]) =>
		(await run<Array<{ sha256: string }>>("touch", hashes)).map((row) => row.sha256);
	const protect = (hash: string) => {
		activeLeases.set(hash, (activeLeases.get(hash) ?? 0) + 1);
		return () => {
			const count = activeLeases.get(hash) ?? 1;
			if (count === 1) activeLeases.delete(hash);
			else activeLeases.set(hash, count - 1);
		};
	};
	const toolSnapshots = createPrefixToolSnapshots({
		putBatch: (values) => run("putJsonBatch", values),
		getBatch: (hashes) => run("getJsonBatch", hashes),
		putJson: (value) => run("putJson", value),
		readJson,
		peek,
		remember,
		touch,
		protect,
		check,
	});

	return {
		putPrefixText: (text, signal) => run<string>("putText", text, signal),
		getPrefixText: (hash, signal) => run<string>("getText", hash, signal),
		putPrefixJson(value, signal) {
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
			if (signal?.aborted) return Promise.reject(signal.reason);
			let pending = pendingReads.get(hash);
			if (!pending) {
				pending = readJson<T>(hash).finally(() => pendingReads.delete(hash));
				pendingReads.set(hash, pending);
			}
			return waitForPrefix(pending as Promise<T>, signal);
		},
		...toolSnapshots,
		async withPrefixSnapshotPublication<T>(
			hashes: readonly string[],
			publish: () => Promise<T>,
			signal?: AbortSignal,
		): Promise<T> {
			check();
			signal?.throwIfAborted();
			const roots = [...new Set(hashes)];
			for (const hash of roots) activeLeases.set(hash, (activeLeases.get(hash) ?? 0) + 1);
			let timer: ReturnType<typeof setInterval> | undefined;
			let refreshing = false;
			try {
				await run("lease", roots, signal);
				timer = setInterval(() => {
					if (refreshing) return;
					refreshing = true;
					void run("lease", roots)
						.catch(() => console.warn("Prefix snapshot publication lease refresh failed"))
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
		},
		async cleanupPrefixSnapshots(options: PrefixSnapshotGcOptions = {}, signal?: AbortSignal) {
			try {
				const result = await run<PrefixSnapshotGcResult>(
					"collect",
					{
						...options,
						protectedHashes: [...(options.protectedHashes ?? []), ...activeLeases.keys()],
					},
					signal,
				);
				if (result.deleted) {
					jsonCache.clear();
					weakValues.clear();
					retainedJsonBytes = 0;
					toolSnapshots.invalidate();
				}
				return result;
			} catch (error) {
				// Shutdown must not write the clean marker until an aborted GC worker has exited.
				await retiring;
				throw error;
			}
		},
		async close() {
			closed = true;
			jsonCache.clear();
			weakValues.clear();
			retainedJsonBytes = 0;
			clearTimeout(idle);
			for (const abort of aborters) abort();
			retire();
			await tail;
			await retiring;
		},
	};
}

const state = hotSafe("narrator.prefixSnapshots.v2", () => ({
	store: undefined as Promise<PrefixSnapshotStore> | undefined,
	maintenance: undefined as (() => Promise<void>) | undefined,
}));
async function defaultStore(): Promise<PrefixSnapshotStore> {
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
				state.store = undefined;
				throw error;
			});
	}
	return state.store;
}

/** Drain the default snapshot resources; a later request lazily opens a fresh store. */
export async function closePrefixSnapshotStore(): Promise<void> {
	const stop = state.maintenance;
	state.maintenance = undefined;
	if (stop) await stop();
	const previous = state.store;
	state.store = undefined;
	if (previous) await (await previous).close();
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
					console.warn("Prefix snapshot maintenance failed; no incomplete mark pass is swept");
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
	state.maintenance ??= createPrefixSnapshotMaintenance((signal) =>
		cleanupPrefixSnapshots({}, signal),
	);
	const stop = state.maintenance;
	return async () => {
		await stop();
		if (state.maintenance === stop) state.maintenance = undefined;
	};
}
