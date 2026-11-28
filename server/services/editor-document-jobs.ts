import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { EDITOR_IO_TIMEOUT_MS } from "../../shared/editor-document";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isCompiledRuntime } from "../lib/runtime-target";
import { WorkerCleanupError, type WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { WorkerPool, type WorkerTaskContext } from "../lib/worker-runtime/pool";
import { TaskQueue, TaskQueueError, type TaskQueuePermit } from "../lib/worker-runtime/queue";
import type { EditorWorkerRequest, EditorWorkerResult } from "./editor-document-worker";

/** Additional build entries become .js paths relative to the build root, whereas
 * import.meta.url in every compiled module identifies the binary itself. */
export function editorWorkerSpecifierCandidates(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"services/editor-document-worker.ts",
		"./editor-document-worker.ts",
		moduleUrl,
		compiled,
	);
}
const WORKER_READY_TIMEOUT_MS = 5_000;
const timeoutError = () =>
	new AppError("Editor task cancelled or timed out", 408, "EDITOR_TIMEOUT");
const closedError = () => new AppError("Editor IO is closed", 503, "EDITOR_CLOSED");
function admissionError(error: unknown): unknown {
	if (!(error instanceof TaskQueueError)) return error;
	if (error.code === "TASK_QUEUE_FULL")
		return new AppError("Editor IO queue is full", 429, "EDITOR_BUSY");
	return error.code === "TASK_QUEUE_CLOSED" ? closedError() : timeoutError();
}

/** Translate only the cancellation reason; release still belongs to the original queue lease. */
function editorPermit(
	permit: TaskQueuePermit,
	reason: (error: unknown) => unknown = admissionError,
): TaskQueuePermit {
	const controller = new AbortController();
	const abort = () => controller.abort(reason(permit.signal.reason));
	permit.signal.addEventListener("abort", abort, { once: true });
	if (permit.signal.aborted) abort();
	return {
		signal: controller.signal,
		deadlineAt: permit.deadlineAt,
		release: () => {
			permit.signal.removeEventListener("abort", abort);
			permit.release();
		},
	};
}

/** A one-shot worker replies, closes its port, then exits. No reply permits replay. */
class EditorJobWorker {
	constructor(private readonly handle: WorkerHandle<Worker>) {}
	get closed() {
		return this.handle.closed;
	}
	async run(request: EditorWorkerRequest, context: WorkerTaskContext): Promise<EditorWorkerResult> {
		const worker = this.handle.resource;
		let response: { result?: EditorWorkerResult; error?: string; code?: string } | undefined;
		const receive = (message: typeof response) => {
			response = message;
		};
		worker.on("message", receive);
		try {
			context.signal.throwIfAborted();
			worker.postMessage(request);
			const code = await this.handle.exited;
			if (code !== 0 || !response)
				throw new AppError("Editor worker exited without a result", 500, "EDITOR_WORKER_FAILED");
			if (response.error || !response.result)
				throw new AppError(
					response.error ?? "Editor worker failed",
					response.code === "EDITOR_SOURCE_CHANGED" ? 409 : 422,
					response.code === "EDITOR_SOURCE_CHANGED" ? response.code : "EDITOR_INVALID_CONTENT",
				);
			return response.result;
		} finally {
			worker.off("message", receive);
		}
	}
	async close() {
		try {
			await this.handle.close();
		} catch (error) {
			// A failed terminate is not proof that a borrowed parent FD is no longer in use.
			await this.handle.exited;
			throw error;
		}
	}
}

/** Admission spans raw-before/blob/dispatch/receipt IO; nested encoding reuses it. */
export class EditorDocumentJobs {
	private readonly io = new TaskQueue({
		concurrency: 4,
		maxQueued: 32,
		maxActivePerKey: 1,
		maxQueuedPerKey: 2,
	});
	private readonly transfer = new TaskQueue({
		concurrency: 8,
		maxQueued: 64,
		maxActiveBytes: 128 * 1024 * 1024,
		maxQueuedBytes: 64 * 64 * 1024 * 1024,
	});
	private readonly context = new AsyncLocalStorage<{ userId: string; signal: AbortSignal }>();
	private readonly shutdown = new AbortController();
	private readonly pool: WorkerPool<EditorWorkerRequest, EditorWorkerResult>;
	private closing?: Promise<void>;

	/** Explicit entries/budgets are trusted fault-injection seams, not HTTP metadata. */
	constructor(workerSpecifiers?: readonly string[], budget = { readyMs: WORKER_READY_TIMEOUT_MS }) {
		this.pool = new WorkerPool({
			concurrency: 4,
			// The business IO queue already owns scheduling. This only caps physical workers.
			maxQueued: 0,
			reuse: false,
			create: async ({ signal }) => {
				try {
					const { handle } = await connectCompiledWorker(
						workerSpecifiers ?? editorWorkerSpecifierCandidates(),
						{
							signal,
							timeoutMs: budget.readyMs,
							sendPing: false,
							isReady: (message) =>
								!!message &&
								typeof message === "object" &&
								"type" in message &&
								message.type === "editor-worker-ready" &&
								"version" in message &&
								message.version === 1,
						},
					);
					return new EditorJobWorker(handle);
				} catch (error) {
					if (error instanceof WorkerCleanupError) {
						// Keep the factory, physical slot and business permit pending until real exit.
						await error.handle.exited;
						throw error;
					}
					signal.throwIfAborted();
					throw new AppError("Editor worker did not become ready", 503, "EDITOR_WORKER_FAILED");
				}
			},
			onTaskComplete: (timing) => {
				if (timing.totalMs >= 1000) logger.warn("Slow editor worker", { ...timing });
			},
		});
	}
	get diagnostics() {
		return { io: this.io.stats, transfer: this.transfer.stats, workers: this.pool.stats };
	}
	/** Independent response-body credit, held until its consumer closes/cancels. */
	async acquireTransfer(bytes: number, external?: AbortSignal) {
		if (external?.aborted) throw timeoutError();
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64 * 1024 * 1024)
			throw new AppError("Invalid editor transfer size", 422, "EDITOR_INVALID_CONTENT");
		const signal = external
			? AbortSignal.any([external, this.shutdown.signal])
			: this.shutdown.signal;
		try {
			const permit = await this.transfer.acquire({
				bytes,
				signal,
				deadlineAt: Date.now() + EDITOR_IO_TIMEOUT_MS,
			});
			return editorPermit(permit, () =>
				this.shutdown.signal.aborted ? closedError() : timeoutError(),
			);
		} catch (error) {
			if (this.shutdown.signal.aborted) throw closedError();
			if (external?.aborted) throw timeoutError();
			throw admissionError(error);
		}
	}
	async withIo<T>(
		userId: string,
		body: (signal: AbortSignal) => Promise<T>,
		external?: AbortSignal,
	): Promise<T> {
		if (this.shutdown.signal.aborted) throw closedError();
		const inherited = this.context.getStore();
		if (inherited?.userId === userId)
			return body(external ? AbortSignal.any([external, inherited.signal]) : inherited.signal);
		const signal = external
			? AbortSignal.any([external, this.shutdown.signal])
			: this.shutdown.signal;
		const permit = await this.io
			.acquire({ key: userId, signal, deadlineAt: Date.now() + EDITOR_IO_TIMEOUT_MS })
			.then((permit) => editorPermit(permit))
			.catch((error) => {
				throw admissionError(error);
			});
		try {
			permit.signal.throwIfAborted();
			return await this.context.run({ userId, signal: permit.signal }, () => body(permit.signal));
		} finally {
			// Durable dispatch may ignore cancellation until its outcome has settled.
			permit.release();
		}
	}
	run(userId: string, request: EditorWorkerRequest, signal?: AbortSignal) {
		return this.withIo(
			userId,
			async (admitted) => {
				const run = (input: EditorWorkerRequest) =>
					this.pool
						.run(input, { signal: admitted, deadlineAt: Number.POSITIVE_INFINITY })
						.catch((error) => {
							if (admitted.aborted)
								throw this.shutdown.signal.aborted ? closedError() : timeoutError();
							throw admissionError(error);
						});
				if (request.action !== "raw-seal") return run(request);
				const entry = await lstat(request.path);
				if (!entry.isFile() || entry.nlink !== 1)
					throw new AppError(
						"Raw stage is not private regular storage",
						422,
						"EDITOR_INVALID_CONTENT",
					);
				const file = await open(
					request.path,
					constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
				);
				try {
					return await run({ ...request, fd: file.fd });
				} finally {
					// Pool completion includes actual exit, even if termination itself failed.
					await file.close();
				}
			},
			signal,
		);
	}
	/** Stop new/queued work immediately; resolve only after active IO, bodies and workers drain. */
	close(): Promise<void> {
		if (this.closing) return this.closing;
		const io = this.io.close(closedError());
		const transfer = this.transfer.close(closedError());
		this.shutdown.abort(closedError());
		this.closing = Promise.all([io, transfer, this.pool.close(closedError())]).then(() => {});
		return this.closing;
	}
}
