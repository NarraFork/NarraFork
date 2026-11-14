import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { getDbWorkerAvailability } from "../lib/db-worker/pool";
import { hotSafe } from "../lib/hot-safe";
import { WorkerCleanupError } from "../lib/worker-runtime/lifecycle";
import { TaskQueue } from "../lib/worker-runtime/queue";
import {
	TOKEN_RECALCULATION_BATCH_TIMEOUT_MS,
	type TokenRecalculationBatchResult,
	type TokenRecalculationRow,
	type TokenRecalculationStore,
} from "./token-recalculation";
import type { TokenRecalculationWorkerRequest } from "./token-recalculation-worker";

type Request = Exclude<TokenRecalculationWorkerRequest, { action: "ping" }>;
type RequestInput = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;
function createStartupQueue() {
	return new TaskQueue({
		concurrency: 2,
		maxQueued: 32,
		maxQueuedBytes: 64 * 1024 * 1024,
		timeoutMs: TOKEN_RECALCULATION_BATCH_TIMEOUT_MS,
	});
}
function checkMaintenance() {
	if (getDbWorkerAvailability().reason === "pool_shutdown")
		throw new Error("Token recalculation workers paused for database maintenance");
}
const owner = hotSafe("narrafork.tokenRecalculation.workers", () => ({
	queue: createStartupQueue(),
	closed: false,
	permanent: false,
	startup: new AbortController(),
	sessions: new Set<() => Promise<void>>(),
	starts: new Set<Promise<unknown>>(),
	closing: undefined as Promise<void> | undefined,
}));

/** A session owns one initialized database connection; it is never replayed on another worker. */
export function createTokenRecalculationWorkerStore(
	dbPath: string,
	signal?: AbortSignal,
): Promise<TokenRecalculationStore> {
	if (owner.closed) return Promise.reject(new Error("Token recalculation workers are closed"));
	if (owner.sessions.size + owner.starts.size >= 32)
		return Promise.reject(new Error("Token recalculation session limit reached"));
	const deadlineAt = Date.now() + TOKEN_RECALCULATION_BATCH_TIMEOUT_MS;
	const starting = owner.queue
		.acquire({
			signal: AbortSignal.any([...(signal ? [signal] : []), owner.startup.signal]),
			deadlineAt,
			bytes: dbPath.length * 2,
		})
		.then(async (permit) => {
			let retiring = false;
			try {
				permit.signal.throwIfAborted();
				return await createStore(dbPath, permit.signal, permit.deadlineAt);
			} catch (error) {
				if (error instanceof WorkerCleanupError) {
					retiring = true;
					void error.handle.exited.then(
						() => permit.release(),
						() => {},
					);
				}
				throw error;
			} finally {
				if (!retiring) permit.release();
			}
		});
	owner.starts.add(starting);
	void starting.finally(() => owner.starts.delete(starting)).catch(() => {});
	return starting;
}

async function createStore(
	dbPath: string,
	signal: AbortSignal,
	deadlineAt: number,
): Promise<TokenRecalculationStore> {
	checkMaintenance();
	const startupSignal = AbortSignal.any([...(signal ? [signal] : []), owner.startup.signal]);
	let connected: Awaited<ReturnType<typeof connectCompiledWorker>>;
	try {
		connected = await connectCompiledWorker(
			compiledWorkerSpecifiers(
				"services/token-recalculation-worker.ts",
				"./token-recalculation-worker.ts",
				import.meta.url,
			),
			{ signal: startupSignal, deadlineAt },
		);
	} catch (error) {
		if (error instanceof WorkerCleanupError) {
			const close = () => error.handle.close();
			owner.sessions.add(close);
			void error.handle.exited.finally(() => owner.sessions.delete(close)).catch(() => {});
		}
		throw error;
	}
	const { worker, handle } = connected;
	const queue = new TaskQueue({
		concurrency: 1,
		maxQueued: 32,
		maxQueuedBytes: 64 * 1024 * 1024,
		timeoutMs: TOKEN_RECALCULATION_BATCH_TIMEOUT_MS,
	});
	const shutdown = new AbortController();
	let sequence = 0;
	let closed = false;
	let initialized = false;
	let closing: Promise<void> | undefined;
	let pending:
		| { id: number; resolve(value: unknown): void; reject(error: unknown): void }
		| undefined;
	worker.on("message", (message: unknown) => {
		if (!pending) return;
		if (
			message &&
			typeof message === "object" &&
			"ready" in message &&
			message.ready === true &&
			!("id" in message)
		)
			return;
		if (
			!message ||
			typeof message !== "object" ||
			Array.isArray(message) ||
			!("id" in message) ||
			typeof message.id !== "number" ||
			!Number.isSafeInteger(message.id)
		) {
			pending.reject(new Error("Invalid token recalculation worker response"));
			void close().catch(() => {});
			return;
		}
		if (message.id !== pending.id) return;
		if ("error" in message && typeof message.error === "string" && !("result" in message))
			pending.reject(new Error(message.error));
		else if ("result" in message && !("error" in message)) pending.resolve(message.result);
		else {
			pending.reject(new Error("Invalid token recalculation worker response"));
			void close().catch(() => {});
		}
	});
	worker.on("error", (error) => pending?.reject(error));
	worker.on("exit", () => {
		closed = true;
		pending?.reject(new Error("Token recalculation worker exited"));
	});
	function dispatch<T>(request: RequestInput, taskSignal: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = ++sequence;
			const finish = (error?: unknown, value?: unknown) => {
				taskSignal.removeEventListener("abort", abort);
				pending = undefined;
				if (error !== undefined) reject(error);
				else resolve(value as T);
			};
			const abort = () => {
				// A permit is retained until the real worker exit, not merely terminate() invocation.
				void handle.close().then(
					() => finish(taskSignal.reason),
					(error) => finish(error),
				);
			};
			pending = {
				id,
				resolve: (value) => finish(undefined, value),
				reject: (error) => finish(error),
			};
			taskSignal.addEventListener("abort", abort, { once: true });
			if (taskSignal.aborted) return abort();
			try {
				worker.postMessage({ ...request, id });
			} catch (error) {
				finish(error);
			}
		});
	}
	function call<T>(request: RequestInput, options?: { signal?: AbortSignal; deadlineAt?: number }) {
		if (closed || handle.closed)
			return Promise.reject<T>(new Error("Token recalculation worker is closed"));
		// Only scalar metadata is measured; no copying/stringification of batch bodies.
		const bytes =
			request.action === "apply"
				? request.updates.reduce(
						(total, { before }) =>
							total +
							256 +
							2 *
								(before.id.length +
									before.created_at.length +
									(before.provider?.length ?? 0) +
									(before.model?.length ?? 0) +
									(before.credential_id?.length ?? 0)),
						0,
					)
				: request.action === "init"
					? dbPath.length * 2
					: 256;
		return queue.run(
			async (permit) => {
				checkMaintenance();
				try {
					return await dispatch<T>(request, permit.signal);
				} finally {
					if (permit.signal.aborted || handle.closed) await handle.close();
				}
			},
			{
				bytes,
				deadlineAt: options?.deadlineAt ?? Date.now() + TOKEN_RECALCULATION_BATCH_TIMEOUT_MS,
				signal: AbortSignal.any([shutdown.signal, ...(options?.signal ? [options.signal] : [])]),
			},
		);
	}
	function close(): Promise<void> {
		if (closing) return closing;
		closed = true;
		const reason = new Error("Token recalculation worker is closed");
		const idle = queue.stats.active === 0;
		const drained = queue.close(reason);
		shutdown.abort(reason);
		closing = (async () => {
			try {
				try {
					if (idle && initialized && !handle.closed)
						await dispatch(
							{ action: "close" },
							AbortSignal.timeout(TOKEN_RECALCULATION_BATCH_TIMEOUT_MS),
						);
				} finally {
					await handle.close();
				}
				await drained;
			} finally {
				if (handle.closed) {
					// On failed cleanup ownership remains until its exit is confirmed.
					void handle.exited.then(
						() => owner.sessions.delete(close),
						() => {},
					);
				}
			}
		})();
		return closing;
	}
	owner.sessions.add(close);
	try {
		if (owner.closed) throw new Error("Token recalculation workers are closed");
		await call({ action: "init", dbPath }, { signal: startupSignal, deadlineAt });
		initialized = true;
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new WorkerCleanupError(handle, cleanupError);
		}
		throw error;
	}
	return {
		scan: (scope, cursor) => call<TokenRecalculationRow[]>({ action: "scan", scope, cursor }),
		apply: (updates) => call<TokenRecalculationBatchResult>({ action: "apply", updates }),
		close,
	};
}

/** Permanent production shutdown, including sessions still waiting for readiness. */
export function closeTokenRecalculationWorkers(): Promise<void> {
	return stopTokenRecalculationWorkers(true);
}
export function pauseTokenRecalculationWorkers(): Promise<void> {
	return stopTokenRecalculationWorkers(false);
}
function stopTokenRecalculationWorkers(permanent: boolean): Promise<void> {
	owner.permanent ||= permanent;
	if (owner.closing) return owner.closing;
	owner.closed = true;
	const drained = owner.queue.close();
	owner.startup.abort(new Error("Token recalculation workers are closed"));
	owner.closing = (async () => {
		// Cancel at the existing owner's batch boundary. An apply already committing must
		// report its committed counts before this lifecycle barrier terminates its session.
		const { getTokenRecalculationService } = await import("./token-recalculation-service");
		const service = getTokenRecalculationService();
		const job = service.get();
		if (job?.status === "running") {
			service.cancel(job.id);
			await service.wait();
		}
		const closing = Promise.all([...owner.sessions].map((close) => close()));
		// Observe cleanup failures immediately while cancelled startups are unwinding.
		void closing.catch(() => {});
		await Promise.allSettled([...owner.starts]);
		await Promise.all([drained, closing, ...[...owner.sessions].map((close) => close())]);
	})();
	return owner.closing;
}
export async function resumeTokenRecalculationWorkers(): Promise<void> {
	if (owner.permanent) throw new Error("Token recalculation workers are permanently closed");
	try {
		await owner.closing;
	} catch (error) {
		if (owner.sessions.size || owner.starts.size || owner.queue.stats.active) throw error;
	}
	if (owner.permanent) throw new Error("Token recalculation workers are permanently closed");
	if (!owner.closed) return;
	reopen();
}
function reopen() {
	owner.closed = false;
	owner.startup = new AbortController();
	owner.queue = createStartupQueue();
	owner.closing = undefined;
}
export async function resetTokenRecalculationWorkersForTest(): Promise<void> {
	try {
		await closeTokenRecalculationWorkers();
	} catch (error) {
		if (owner.sessions.size || owner.starts.size || owner.queue.stats.active) throw error;
	}
	owner.permanent = false;
	reopen();
}
