/**
 * Read-only database worker pool.
 *
 * ## Why
 *
 * `bun:sqlite` is synchronous, so every read runs on the single JS thread that also serves HTTP,
 * WebSocket, and agent sessions. A whole-database read like the storage-settings scan (measured:
 * ~4.9s over 116 tables on a 5.3 GB database) therefore freezes the entire server for its duration.
 *
 * Running the same scan in a Worker was measured to keep the main thread's worst event-loop delay at
 * 11ms — i.e. effectively unaffected — while also allowing the per-table work to be sharded across
 * several workers for real concurrency.
 *
 * ## Safety properties
 *
 * - Workers open their connection `readonly`, so they can never take the write lock.
 * - Worker code must not import `server/db/index.ts` (a test enforces this); see
 *   `storage-scan-queries.ts` for the destructive re-bootstrap that would otherwise occur.
 * - Every task has a single absolute deadline covering BOTH the wait for pool capacity and the
 *   execution itself, and it is cancellable throughout. A caller therefore always settles, which is
 *   what makes the fallback below reachable.
 * - A crashed worker fails only its own in-flight task.
 * - If workers are unavailable for any reason, callers fall back to running the work inline on the
 *   main thread. Degraded performance is acceptable; a missing feature is not.
 * - Pool state is pinned to `globalThis` via hot-safe helpers so Bun `--hot` reloads reuse the
 *   existing workers instead of leaking a new set on every edit.
 */

import { cpus } from "node:os";
import { hotOnce, hotSafe, hotTimerClear } from "../hot-safe";
import { logger } from "../logger";
import { isCompiledRuntime } from "../runtime-target";
import {
	DB_WORKER_PROBE_READY_TIMEOUT_MS,
	DB_WORKER_READY_TIMEOUT_MS,
	type DbReadTaskParams,
	type DbWorkerOutbound,
} from "./protocol";

/** Default task timeout. Generous: a cold cache scan of a multi-GB database can take a while. */
const DEFAULT_TASK_TIMEOUT_MS = 120_000;
/** Idle workers are terminated after this long so a one-off scan does not pin threads forever. */
const IDLE_REAP_MS = 60_000;
const IDLE_REAP_INTERVAL_MS = 15_000;
/** After this many consecutive spawn/ready failures, stop trying and let callers fall back. */
const MAX_SPAWN_FAILURES = 2;

const REAPER_TIMER_KEY = "narrafork.dbWorkerPool.reaper";

export interface RunReadTaskOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Progress callback, invoked as the worker finishes individual tables. */
	onProgress?: (progress: { tableName: string; done: number; total: number }) => void;
	/**
	 * Coalescing key. Concurrent calls sharing a key share one execution, so two admins hitting
	 * "scan" at the same time do not each pay the full cost.
	 */
	dedupeKey?: string;
}

interface PendingTask {
	requestId: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	onProgress?: RunReadTaskOptions["onProgress"];
}

/**
 * Readiness bookkeeping for one worker.
 *
 * Deliberately not a bare promise: a probe (see {@link spawnReadyWorker}) may give up on a candidate
 * after a short budget and later want to wait on the SAME worker again, which a settled promise
 * cannot express. Waiters therefore time out individually while the signal itself stays pending.
 */
interface ReadySignal {
	state: "pending" | "ready" | "failed";
	error: Error | null;
	waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
}

/** A caller parked in the queue, waiting for pool capacity. */
interface QueueWaiter {
	/** Let the waiter retry acquisition. */
	release: () => void;
	/** Reject the waiter (timeout, abort, pool shutdown). */
	fail: (error: Error) => void;
}

interface PooledWorker {
	worker: Worker;
	readySignal: ReadySignal;
	/** Set once a task's requestId is known; used by the idle reaper and crash accounting. */
	busyWith: string | null;
	/**
	 * Claimed BEFORE `busyWith` is known.
	 *
	 * `acquireWorker` awaits worker readiness, and the caller then awaits more before it can post a
	 * task, so `busyWith` alone is not enough to mark a worker as taken: concurrent callers would
	 * all see the same freshly spawned worker as free and pile onto it. That bug made a
	 * concurrency-4 pool run exactly one worker, serialising every task (measured: 4 concurrent
	 * scans took 4x a single scan, a 1.00x "speedup"). This flag is set synchronously at claim time,
	 * before any await, so it closes that window.
	 */
	claimed: boolean;
	idleSince: number;
	terminated: boolean;
}

interface PoolState {
	workers: PooledWorker[];
	pending: Map<string, PendingTask>;
	queue: QueueWaiter[];
	inFlight: Map<string, Promise<unknown>>;
	spawnFailures: number;
	disabledReason: string | null;
	requestCounter: number;
	/** Worker specifier proven to work in this runtime; skips re-probing candidates. */
	resolvedWorkerSpecifier: string | null;
	/**
	 * Slots reserved synchronously while a worker is starting.
	 *
	 * Spawning awaits readiness, so without counting reservations every concurrent caller would pass
	 * the `workers.length < concurrency` check and the pool would overshoot its cap.
	 */
	pendingSpawns: number;
	/**
	 * TEST ONLY (see {@link setDbWorkerSpecifiersForTest}). Overrides the candidate list so a test can
	 * make spawning fail for real rather than by mocking pool internals.
	 */
	testSpecifiers: string[] | null;
}

function state(): PoolState {
	return hotSafe<PoolState>("narrafork.dbWorkerPool", () => ({
		workers: [],
		pending: new Map(),
		queue: [],
		inFlight: new Map(),
		spawnFailures: 0,
		disabledReason: null,
		requestCounter: 0,
		resolvedWorkerSpecifier: null,
		pendingSpawns: 0,
		testSpecifiers: null,
	}));
}

/**
 * Candidate paths for the worker entry inside a compiled binary's virtual filesystem.
 *
 * Three non-obvious facts, all verified against real compiled binaries:
 *   1. In a compiled binary EVERY module reports the binary itself as `import.meta.url`
 *      (`file:///$bunfs/root/narrafork`), so resolving `./worker-entry.js` relatively yields
 *      `$bunfs/root/worker-entry.js` — which does not exist, and `new Worker` then fails
 *      asynchronously with ModuleNotFound.
 *   2. The bundler embeds each additional entry point at its path RELATIVE TO the main entry's
 *      directory, with the extension rewritten to `.js`. For the production entry
 *      (`server/index.ts`) that is `lib/db-worker/worker-entry.js`; for a probe or test harness
 *      outside `server/` it becomes `server/lib/db-worker/worker-entry.js`.
 *   3. Because the layout therefore depends on which entry point was compiled, a single hard-coded
 *      path is fragile. We try the known shapes in order and remember the one that works.
 *
 * Keep in sync with the extra entry point in scripts/build-cross-platform.ts.
 */
const COMPILED_WORKER_PATHS = [
	"./lib/db-worker/worker-entry.js",
	"./server/lib/db-worker/worker-entry.js",
	"./worker-entry.js",
];

/** Specifiers to try, most likely first. Dev has exactly one; compiled has several candidates. */
function workerSpecifierCandidates(): string[] {
	const s = state();
	if (s.testSpecifiers) return s.testSpecifiers;
	if (!isCompiledRuntime()) return [new URL("./worker-entry.ts", import.meta.url).href];
	// Once a candidate has produced a working worker, stop probing the others.
	if (s.resolvedWorkerSpecifier) return [s.resolvedWorkerSpecifier];
	return COMPILED_WORKER_PATHS.map((path) => new URL(path, import.meta.url).href);
}

export function getConfiguredConcurrency(): number {
	const raw = process.env.NARRAFORK_DB_WORKER_CONCURRENCY?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 16);
		if (Number.isFinite(parsed) && parsed <= 0) return 0; // explicit opt-out
	}
	let cpuCount = 4;
	try {
		cpuCount = Math.max(1, cpus().length);
	} catch {
		// keep the default
	}
	return Math.max(1, Math.min(4, cpuCount));
}

function workersDisabled(): string | null {
	if (process.env.NARRAFORK_DB_WORKER === "off") return "disabled_by_env";
	if (getConfiguredConcurrency() === 0) return "concurrency_zero";
	return state().disabledReason;
}

function handleWorkerMessage(pooled: PooledWorker, message: DbWorkerOutbound): void {
	const s = state();
	if (!message || typeof message !== "object") return;
	if (message.type === "ready") return; // handled by the ready promise

	const pending = s.pending.get(message.requestId);
	if (!pending) return;

	if (message.type === "progress") {
		pending.onProgress?.({
			tableName: message.tableName,
			done: message.done,
			total: message.total,
		});
		return;
	}

	clearTimeout(pending.timer);
	s.pending.delete(message.requestId);
	releaseWorker(pooled);

	if (message.type === "result") {
		pending.resolve(message.result);
	} else {
		pending.reject(new Error(message.message));
	}
	drainQueue();
}

/** Return a worker to the idle set. Must clear BOTH the claim and the task binding. */
function releaseWorker(pooled: PooledWorker): void {
	pooled.busyWith = null;
	pooled.claimed = false;
	pooled.idleSince = Date.now();
}

/** Fail every task a dead worker was running, then drop it from the pool. */
function retireWorker(pooled: PooledWorker, reason: string): void {
	const s = state();
	if (pooled.terminated) return;
	pooled.terminated = true;
	s.workers = s.workers.filter((candidate) => candidate !== pooled);
	// A worker that dies before reporting ready must not leave a spawner waiting on its budget.
	settleReady(pooled.readySignal, new Error(`database worker died (${reason})`));
	if (pooled.busyWith) {
		const pending = s.pending.get(pooled.busyWith);
		if (pending) {
			clearTimeout(pending.timer);
			s.pending.delete(pooled.busyWith);
			pending.reject(new Error(`database worker died (${reason})`));
		}
	}
	releaseWorker(pooled);
	try {
		pooled.worker.terminate();
	} catch {
		// best effort
	}
	drainQueue();
}

function settleReady(signal: ReadySignal, error: Error | null): void {
	if (signal.state !== "pending") return;
	signal.state = error ? "failed" : "ready";
	signal.error = error;
	const waiters = signal.waiters.splice(0, signal.waiters.length);
	for (const waiter of waiters) {
		if (error) waiter.reject(error);
		else waiter.resolve();
	}
}

/**
 * Wait for readiness with an individual budget.
 *
 * The budget belongs to the WAITER, not the worker: a probe uses a short one, and giving up does not
 * mark the worker as failed (the caller retires it explicitly). That separation is what lets probing
 * three candidate paths cost milliseconds instead of one full ready timeout each.
 */
function awaitReady(pooled: PooledWorker, timeoutMs: number): Promise<void> {
	const signal = pooled.readySignal;
	if (signal.state === "ready") return Promise.resolve();
	if (signal.state === "failed") {
		return Promise.reject(signal.error ?? new Error("database worker failed to start"));
	}
	return new Promise<void>((resolve, reject) => {
		const waiter = {
			resolve: () => {
				clearTimeout(timer);
				resolve();
			},
			reject: (error: Error) => {
				clearTimeout(timer);
				reject(error);
			},
		};
		const timer = setTimeout(() => {
			const index = signal.waiters.indexOf(waiter);
			if (index >= 0) signal.waiters.splice(index, 1);
			reject(new Error(`database worker did not become ready within ${timeoutMs}ms`));
		}, timeoutMs);
		signal.waiters.push(waiter);
	});
}

/** Start a worker from one specific specifier. Its ready signal settles on the ready/error event. */
function spawnWorkerFrom(specifier: string): PooledWorker {
	const worker = new Worker(specifier);
	const pooled: PooledWorker = {
		worker,
		busyWith: null,
		claimed: false,
		idleSince: Date.now(),
		terminated: false,
		readySignal: { state: "pending", error: null, waiters: [] },
	};

	// A wrong specifier fails ASYNCHRONOUSLY (ModuleNotFound on the error event). Listeners are
	// removed as soon as readiness settles: without that, the closures — and the worker they capture —
	// stay reachable from the worker's listener list for the rest of its life.
	const onFirstMessage = (event: MessageEvent<DbWorkerOutbound>) => {
		if (event.data?.type !== "ready") return;
		removeReadyListeners();
		settleReady(pooled.readySignal, null);
	};
	const onStartupError = (event: ErrorEvent) => {
		removeReadyListeners();
		settleReady(pooled.readySignal, new Error(event?.message ?? "database worker failed to start"));
	};
	function removeReadyListeners(): void {
		worker.removeEventListener("message", onFirstMessage as EventListener);
		worker.removeEventListener("error", onStartupError as EventListener);
	}
	worker.addEventListener("message", onFirstMessage as EventListener);
	worker.addEventListener("error", onStartupError as EventListener);

	worker.onmessage = (event: MessageEvent<DbWorkerOutbound>) =>
		handleWorkerMessage(pooled, event.data);
	worker.onerror = (event: ErrorEvent) => {
		retireWorker(pooled, event?.message ?? "worker error");
	};
	// Bun fires this when the worker thread exits (including our own shutdown request).
	worker.addEventListener("close", (() => retireWorker(pooled, "closed")) as EventListener);

	ensureReaper();
	return pooled;
}

/**
 * Spawn a ready worker, probing candidate specifiers until one works.
 *
 * Probing exists because the embedded worker path in a compiled binary depends on which entry point
 * was compiled (see COMPILED_WORKER_PATHS). The winning specifier is cached, so this costs at most
 * one round of failed spawns per process.
 *
 * The last candidate is not a probe: once every other shape has been ruled out, a slow-but-correct
 * worker still deserves the full ready budget. Earlier candidates get the short probe budget, which
 * is what keeps a compiled binary's first spawn from costing 3 x DB_WORKER_READY_TIMEOUT_MS.
 */
async function spawnReadyWorker(): Promise<PooledWorker> {
	const candidates = workerSpecifierCandidates();
	const failures: string[] = [];
	for (const [index, specifier] of candidates.entries()) {
		const isLastCandidate = index === candidates.length - 1;
		const budget = isLastCandidate ? DB_WORKER_READY_TIMEOUT_MS : DB_WORKER_PROBE_READY_TIMEOUT_MS;
		const pooled = spawnWorkerFrom(specifier);
		try {
			await awaitReady(pooled, budget);
			state().resolvedWorkerSpecifier = specifier;
			return pooled;
		} catch (err) {
			failures.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
			retireWorker(pooled, "candidate rejected");
		}
	}
	throw new Error(`no usable database worker entry (tried ${failures.join(" | ")})`);
}

/**
 * Outcome of trying to get a worker.
 *
 * The three cases used to collapse into `PooledWorker | null`, and conflating the last two deadlocked
 * the pool: a caller that hit a spawn FAILURE queued itself waiting for a `drainQueue` that could
 * never come, because no live worker remained to finish a task and trigger one. Capacity pressure is
 * transient and worth queueing for; a spawn failure is not.
 */
type AcquireOutcome =
	| { kind: "worker"; worker: PooledWorker }
	| { kind: "at_capacity" }
	| { kind: "spawn_failed"; reason: string };

/**
 * Take an idle worker, or grow the pool.
 *
 * Claims synchronously (before the first `await`) so two concurrent callers can never be handed the
 * same worker.
 */
async function acquireWorker(): Promise<AcquireOutcome> {
	const s = state();
	// Also checked at the `runReadTask` entry point, but a caller released from the queue re-enters
	// here directly — without this the pool would keep paying for spawns after being declared dead.
	const disabled = workersDisabled();
	if (disabled) return { kind: "spawn_failed", reason: disabled };

	const idle = s.workers.find(
		(pooled) => !pooled.claimed && !pooled.busyWith && !pooled.terminated,
	);
	if (idle) {
		idle.claimed = true;
		return { kind: "worker", worker: idle };
	}

	// Reserve the slot synchronously: spawning awaits readiness, so counting only live workers would
	// let concurrent callers overshoot the configured cap.
	if (s.workers.length + s.pendingSpawns >= getConfiguredConcurrency())
		return { kind: "at_capacity" };
	s.pendingSpawns += 1;

	try {
		const pooled = await spawnReadyWorker();
		// Claimed before returning, so a concurrent caller grows the pool rather than taking this one.
		pooled.claimed = true;
		s.workers.push(pooled);
		s.spawnFailures = 0;
		return { kind: "worker", worker: pooled };
	} catch (err) {
		s.spawnFailures += 1;
		if (s.spawnFailures >= MAX_SPAWN_FAILURES) {
			s.disabledReason = "worker_unavailable";
			logger.warn("Database read workers disabled after repeated startup failures", {
				error: err instanceof Error ? err.message : String(err),
			});
		} else {
			logger.warn("Database read worker failed to start", {
				error: err instanceof Error ? err.message : String(err),
				spawnFailures: s.spawnFailures,
			});
		}
		return { kind: "spawn_failed", reason: "worker_spawn_failed" };
	} finally {
		s.pendingSpawns -= 1;
	}
}

/** How many queued waiters can realistically be served right now. */
function availableCapacity(): number {
	const s = state();
	const idle = s.workers.filter(
		(pooled) => !pooled.claimed && !pooled.busyWith && !pooled.terminated,
	).length;
	const growable = Math.max(0, getConfiguredConcurrency() - (s.workers.length + s.pendingSpawns));
	return idle + growable;
}

/**
 * Release queued waiters, at most as many as there is capacity for.
 *
 * The quota matters because releasing a waiter only resolves its promise: the actual claim happens a
 * microtask later, so `availableCapacity()` would report the same value for the whole loop. The
 * previous unbounded loop therefore released the ENTIRE queue on any completion; all but one waiter
 * failed to acquire and re-queued at the tail, destroying FIFO order (starvation under load) and
 * churning through pointless dequeue/enqueue cycles.
 */
function drainQueue(): void {
	const s = state();
	let quota = availableCapacity();
	while (quota > 0 && s.queue.length > 0) {
		const next = s.queue.shift();
		quota -= 1;
		next?.release();
	}
}

function ensureReaper(): void {
	// Not hotTimer(): that clears and recreates on every module evaluation, which would drop the
	// interval mid-flight. We want one long-lived reaper, recreated only if it is missing.
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol storage survives hot reload
	const g = globalThis as any;
	const sym = Symbol.for(REAPER_TIMER_KEY);
	if (g[sym]) return;
	const timer = setInterval(() => {
		const s = state();
		const now = Date.now();
		for (const pooled of [...s.workers]) {
			// `claimed` covers the window between being handed out and receiving its task, so the
			// reaper cannot terminate a worker that is about to be used.
			if (pooled.claimed || pooled.busyWith || pooled.terminated) continue;
			if (now - pooled.idleSince < IDLE_REAP_MS) continue;
			try {
				pooled.worker.postMessage({ type: "shutdown" });
			} catch {
				// fall through to terminate
			}
			retireWorker(pooled, "idle");
		}
	}, IDLE_REAP_INTERVAL_MS);
	timer.unref?.();
	g[sym] = timer;
}

/**
 * Park until the pool has capacity, or the budget/abort ends the wait.
 *
 * Queue waiting used to be unbounded and uncancellable: neither the task timeout nor the abort signal
 * was armed before a worker had been obtained, so a caller stuck here never settled and its callers'
 * fallbacks never ran (an SSE request would hang until the client gave up, and shutdown then blocked
 * on HTTP drain). Both are now armed for the wait itself, and a waiter removes ITS OWN entry from the
 * queue when it gives up so a later drain does not release a dead slot.
 */
function waitForCapacity(deadlineAt: number, signal: AbortSignal | undefined): Promise<void> {
	const s = state();
	return new Promise<void>((resolve, reject) => {
		const waiter: QueueWaiter = {
			release: () => {
				finish();
				resolve();
			},
			fail: (error: Error) => {
				finish();
				reject(error);
			},
		};

		const remaining = Math.max(0, deadlineAt - Date.now());
		const timer = setTimeout(() => {
			dequeue();
			finish();
			reject(new Error(`database read task timed out after ${remaining}ms waiting for a worker`));
		}, remaining);

		const onAbort = () => {
			dequeue();
			finish();
			reject(new Error("database read task aborted"));
		};

		function dequeue(): void {
			const index = s.queue.indexOf(waiter);
			if (index >= 0) s.queue.splice(index, 1);
		}
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		if (signal?.aborted) {
			finish();
			reject(new Error("database read task aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		s.queue.push(waiter);
	});
}

/**
 * Post one task to a worker and await its result.
 *
 * `deadlineAt` is an absolute deadline rather than a duration so time already spent queueing is
 * charged against the same budget: the caller asked for "a result within timeoutMs", not "timeoutMs
 * of worker execution after an unbounded wait".
 */
async function dispatch(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions,
	deadlineAt: number,
): Promise<unknown> {
	const s = state();

	// Loop rather than recurse: a released waiter may still lose the race for the freed worker, and
	// retrying must not grow the stack or reset the deadline.
	let pooled: PooledWorker | null = null;
	while (!pooled) {
		const outcome = await acquireWorker();
		if (outcome.kind === "worker") {
			pooled = outcome.worker;
			break;
		}
		// Spawning failed: no live worker exists to ever trigger a drain, so queueing here would wait
		// forever. Surface it and let the caller run its main-thread fallback.
		if (outcome.kind === "spawn_failed") throw new WorkersUnavailableError(outcome.reason);
		await waitForCapacity(deadlineAt, options.signal);
	}
	const worker = pooled;

	s.requestCounter += 1;
	const requestId = `dbr-${Date.now().toString(36)}-${s.requestCounter.toString(36)}`;
	worker.busyWith = requestId;

	return new Promise<unknown>((resolve, reject) => {
		// Local cancellation scope: aborting it detaches the caller's abort listener once the task
		// settles, so neither `reject` nor the worker stays reachable through the signal.
		const scope = new AbortController();
		const remaining = Math.max(0, deadlineAt - Date.now());

		const settleReject = (error: Error) => {
			scope.abort();
			reject(error);
		};
		const settleResolve = (value: unknown) => {
			scope.abort();
			resolve(value);
		};

		const timer = setTimeout(() => {
			s.pending.delete(requestId);
			// A timed-out worker may still be mid-scan; retire it rather than reusing a busy thread.
			retireWorker(worker, "task timeout");
			settleReject(new Error(`database read task timed out after ${remaining}ms`));
		}, remaining);
		scope.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

		s.pending.set(requestId, {
			requestId,
			resolve: settleResolve,
			reject: settleReject,
			timer,
			onProgress: options.onProgress,
		});

		if (options.signal) {
			if (options.signal.aborted) {
				s.pending.delete(requestId);
				releaseWorker(worker);
				settleReject(new Error("database read task aborted"));
				// Cancellation may have happened while this worker was starting. Wake callers
				// that queued behind its startup reservation now that the worker is idle.
				drainQueue();
				return;
			}
			options.signal.addEventListener(
				"abort",
				() => {
					const pending = s.pending.get(requestId);
					if (!pending) return;
					s.pending.delete(requestId);
					retireWorker(worker, "aborted");
					settleReject(new Error("database read task aborted"));
				},
				{ once: true, signal: scope.signal },
			);
		}

		try {
			worker.worker.postMessage({ type: "task", requestId, dbPath, params });
		} catch (err) {
			s.pending.delete(requestId);
			retireWorker(worker, "postMessage failed");
			settleReject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

/** Thrown when the pool cannot run a task at all, signalling the caller to use its fallback. */
export class WorkersUnavailableError extends Error {
	constructor(public readonly reason: string) {
		super(`database read workers unavailable: ${reason}`);
		this.name = "WorkersUnavailableError";
	}
}

/**
 * Run a read-only task in a worker.
 *
 * Throws {@link WorkersUnavailableError} when workers cannot be used; callers are expected to catch
 * that and run their main-thread fallback.
 */
export async function runReadTask<T>(
	dbPath: string,
	params: DbReadTaskParams,
	options: RunReadTaskOptions = {},
): Promise<T> {
	const disabled = workersDisabled();
	if (disabled) throw new WorkersUnavailableError(disabled);

	const s = state();
	const key = options.dedupeKey;
	if (key) {
		const existing = s.inFlight.get(key);
		if (existing) return existing as Promise<T>;
	}

	// One absolute deadline for the whole attempt (queue wait + execution), fixed here so retries
	// after a lost capacity race cannot silently extend it.
	const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
	const execution = dispatch(dbPath, params, options, deadlineAt).finally(() => {
		if (key) s.inFlight.delete(key);
	});
	if (key) s.inFlight.set(key, execution);
	return execution as Promise<T>;
}

/** Terminate all workers and clear pool state. Safe to call repeatedly. */
export function shutdownDbWorkerPool(): void {
	const s = state();
	hotTimerClear(REAPER_TIMER_KEY);
	// Empty the queue FIRST. Retiring a worker calls `drainQueue`, which would otherwise release a
	// waiter mid-shutdown; that waiter then sees free capacity and spawns a brand new worker just as
	// the pool is being torn down. Detaching the waiters before any retirement closes that window.
	// Reject rather than drop them: a dropped waiter is a promise that never settles, which is exactly
	// the hang this pool exists to avoid.
	const waiters = s.queue.splice(0, s.queue.length);
	for (const waiter of waiters) {
		waiter.fail(new WorkersUnavailableError("pool_shutdown"));
	}
	for (const pooled of [...s.workers]) {
		try {
			pooled.worker.postMessage({ type: "shutdown" });
		} catch {
			// fall through
		}
		retireWorker(pooled, "pool shutdown");
	}
	s.workers = [];
	s.inFlight.clear();
	for (const pending of s.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error("database worker pool shut down"));
	}
	s.pending.clear();
}

/** Test/diagnostic hook: re-enable workers after a simulated failure. */
export function resetDbWorkerPoolForTest(): void {
	const s = state();
	shutdownDbWorkerPool();
	s.spawnFailures = 0;
	s.disabledReason = null;
	s.pendingSpawns = 0;
	s.resolvedWorkerSpecifier = null;
	s.testSpecifiers = null;
}

/**
 * TEST ONLY: force the worker entry specifiers the pool will try.
 *
 * Exists so a test can make spawning fail the way production does — a real `new Worker` against an
 * unresolvable path — instead of stubbing internals and proving nothing about the real code path.
 * Pass `null` to restore normal resolution.
 */
export function setDbWorkerSpecifiersForTest(specifiers: string[] | null): void {
	state().testSpecifiers = specifiers;
}

/**
 * Whether the pool can currently take work, and why not when it cannot.
 *
 * Exists so a caller can report its own capabilities honestly WITHOUT reading pool internals or
 * having to attempt a task first. `getDbWorkerPoolStats` already exposes `disabledReason`, but it
 * also exposes worker counts and queue depth — diagnostics that a capability check has no business
 * depending on, and which would make every such caller re-derive the same `reason === null` rule.
 *
 * Deliberately does NOT spawn anything: a capability query that started a thread would make merely
 * rendering the storage page pay for a worker.
 */
export function getDbWorkerAvailability(): { available: boolean; reason: string | null } {
	const reason = workersDisabled();
	return { available: reason === null, reason };
}

export function getDbWorkerPoolStats(): {
	workers: number;
	busy: number;
	queued: number;
	inFlight: number;
	disabledReason: string | null;
	concurrency: number;
} {
	const s = state();
	return {
		workers: s.workers.length,
		busy: s.workers.filter((pooled) => pooled.busyWith).length,
		queued: s.queue.length,
		inFlight: s.inFlight.size,
		disabledReason: workersDisabled(),
		concurrency: getConfiguredConcurrency(),
	};
}

// Terminate workers on process exit so they never outlive the server.
if (hotOnce("narrafork.dbWorkerPool.exitHandler")) {
	process.on("exit", () => {
		try {
			shutdownDbWorkerPool();
		} catch {
			// best effort at exit
		}
	});
}
