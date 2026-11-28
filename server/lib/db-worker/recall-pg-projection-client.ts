import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { WorkerCleanupError, type WorkerHandle } from "../worker-runtime/lifecycle";
import { TaskQueue, TaskQueueError } from "../worker-runtime/queue";
import { DbReadError } from "./errors";
import { getDbWorkerAvailability } from "./pool";
import type { RecallPgProjectionRequest, RecallPgProjectionResult } from "./recall-pg-projection";

type Load = (signal: AbortSignal, deadlineAt: number) => Promise<RecallPgProjectionRequest | null>;
const unavailable = () =>
	new DbReadError("DB_READ_UNAVAILABLE", "Recall projection Worker unavailable");

/** Admission precedes even the bounded raw SQL fetch; no unbounded retained 40-MiB requests. */
export function createRecallPgProjectionRunner({
	disabled = () => !getDbWorkerAvailability().available,
	launch = async (signal: AbortSignal, deadlineAt: number): Promise<WorkerHandle<Worker>> => {
		const { handle } = await connectCompiledWorker(
			compiledWorkerSpecifiers(
				"lib/db-worker/recall-pg-projection-worker.ts",
				"./recall-pg-projection-worker.ts",
				import.meta.url,
			),
			{ signal, deadlineAt, sendPing: false },
		);
		return handle;
	},
} = {}) {
	const queue = new TaskQueue({ concurrency: 2, maxQueued: 0, timeoutMs: 30_000 });
	return async <T extends RecallPgProjectionResult>(
		load: Load,
		signal?: AbortSignal,
		deadlineAt = Date.now() + 30_000,
	): Promise<T | null> => {
		signal?.throwIfAborted();
		if (disabled()) throw unavailable();
		let permit: Awaited<ReturnType<TaskQueue["acquire"]>>;
		try {
			permit = await queue.acquire({ signal, deadlineAt });
		} catch (error) {
			if (error instanceof TaskQueueError)
				throw new DbReadError(
					error.code === "TASK_QUEUE_TIMEOUT" ? "DB_READ_TASK_TIMEOUT" : "DB_READ_UNAVAILABLE",
					"Recall projection admission failed",
				);
			throw error;
		}
		let handle: WorkerHandle<Worker> | undefined;
		let retainedStartup = false;
		let loading: Promise<RecallPgProjectionRequest | null> | undefined;
		const releaseAfterLoad = () => {
			if (loading) void loading.then(permit.release, permit.release);
			else permit.release();
		};
		const started = performance.now();
		try {
			if (disabled()) throw unavailable();
			handle = await launch(permit.signal, permit.deadlineAt);
			permit.signal.throwIfAborted();
			if (handle.closed) throw unavailable();
			loading = Promise.resolve().then(() => load(permit.signal, permit.deadlineAt));
			const request = await abortableLoad(loading, permit.signal, handle.resource);
			permit.signal.throwIfAborted();
			if (request === null) return null;
			if (handle.closed) throw unavailable();
			return (await receive(handle.resource, request, permit.signal, permit.deadlineAt)) as T;
		} catch (error) {
			if (error instanceof WorkerCleanupError) {
				retainedStartup = true;
				void error.handle.exited.then(permit.release, () => {});
				// Failed cleanup still owns this slot until the actual thread exit.
				throw unavailable();
			}
			if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Recall projection cancelled");
			if (Date.now() >= permit.deadlineAt)
				throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recall projection deadline expired");
			if (error instanceof DbReadError) throw error;
			throw unavailable();
		} finally {
			if (handle) {
				// A cancelled SQL fetch may still finish later: keep its raw-byte admission
				// reserved until BOTH the real thread exit and the fetch settlement.
				void handle.exited.then(releaseAfterLoad, () => {});
				await handle.close().catch(() => {});
			} else {
				// WorkerCleanupError is the sole path with retained startup ownership.
				// launch() communicates that ownership via the catch above.
				if (!retainedStartup) permit.release();
			}
			const elapsedMs = performance.now() - started;
			if (elapsedMs > 250) logger.warn("Slow Recall PG projection", { elapsedMs });
		}
	};
}

function abortableLoad<T>(loading: Promise<T>, signal: AbortSignal, worker: Worker): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (accept: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			worker.off("error", failure);
			worker.off("messageerror", failure);
			worker.off("exit", failure);
			accept();
		};
		const abort = () => finish(() => reject(signal.reason));
		const failure = () => finish(() => reject(unavailable()));
		worker.on("error", failure);
		worker.on("messageerror", failure);
		worker.on("exit", failure);
		signal.addEventListener("abort", abort, { once: true });
		// A late payload is discarded, never projected or parsed after cancellation.
		void loading.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (signal.aborted) abort();
	});
}

function receive(
	worker: Worker,
	request: RecallPgProjectionRequest,
	signal: AbortSignal,
	deadlineAt: number,
): Promise<RecallPgProjectionResult> {
	return new Promise((resolve, reject) => {
		const clean = () => {
			worker.off("message", onMessage);
			worker.off("error", onFailure);
			worker.off("messageerror", onFailure);
			worker.off("exit", onFailure);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			clean();
			reject(signal.reason);
		};
		const onFailure = () => {
			clean();
			reject(unavailable());
		};
		const onMessage = (
			reply: { result?: RecallPgProjectionResult; error?: { code: string } } | null,
		) => {
			clean();
			if (
				reply?.error &&
				["DB_READ_BUDGET", "DB_READ_PROTOCOL", "DB_READ_TASK_TIMEOUT", "DB_READ_FAILED"].includes(
					reply.error.code,
				)
			)
				reject(new DbReadError(reply.error.code, "Recall projection failed"));
			else if (reply?.result && typeof reply.result === "object") resolve(reply.result);
			else reject(unavailable());
		};
		worker.on("message", onMessage);
		worker.on("error", onFailure);
		worker.on("messageerror", onFailure);
		worker.on("exit", onFailure);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) return onAbort();
		try {
			worker.postMessage({ request, deadlineAt });
		} catch {
			onFailure();
		}
	});
}

const owner = hotSafe("narrafork.recallPgProjection", () => ({
	run: createRecallPgProjectionRunner(),
}));
export const runRecallPgProjection = owner.run;
