import { compiledWorkerSpecifiers, connectCompiledWorker } from "./compiled-worker";
import { AppError } from "./errors";
import { hotSafe } from "./hot-safe";
import { logger } from "./logger";
import { isCompiledRuntime } from "./runtime-target";
import type { WorkerHandle } from "./worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "./worker-runtime/pool";
import { TaskQueueError } from "./worker-runtime/queue";

export const ATTACHMENT_DIGEST_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTACHMENT_DIGEST_TIMEOUT_MS = 90_000;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

interface DigestRequest {
	path?: string;
	blob?: Blob;
	maxBytes: number;
}
interface DigestReply {
	ready?: boolean;
	digest?: string;
	error?: string;
	tooLarge?: boolean;
}
type DigestWorkerHandle = ReturnType<typeof WorkerHandle.thread>;

export function attachmentDigestWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"lib/attachment-digest-worker.ts",
		"./attachment-digest-worker.ts",
		moduleUrl,
		compiled,
	);
}
function createPool() {
	return new WorkerPool<DigestRequest, string>({
		concurrency: 2,
		maxQueued: 8,
		maxQueuedBytes: MAX_QUEUED_BYTES,
		timeoutMs: ATTACHMENT_DIGEST_TIMEOUT_MS,
		reuse: false,
		create: createDigestWorker,
		onTaskComplete: (timing) => {
			if (timing.totalMs > 1_000)
				logger.warn("Slow attachment digest", {
					elapsedMs: timing.totalMs,
					queueMs: timing.queueMs,
					execMs: timing.execMs,
					outcome: timing.outcome,
				});
		},
	});
}
const digestWorkers = hotSafe("narrafork.attachmentDigestWorkers", () => ({ pool: createPool() }));

/** Stop admission and wait for actual thread exits. Production close never silently reopens. */
export function closeAttachmentDigestWorkers(): Promise<void> {
	return digestWorkers.pool.close(
		new AppError("Attachment digest workers are unavailable", 503, "ATTACHMENT_DIGEST_UNAVAILABLE"),
	);
}
export async function resetAttachmentDigestWorkersForTests(): Promise<void> {
	await closeAttachmentDigestWorkers();
	digestWorkers.pool = createPool();
}
export function attachmentDigestWorkerStats() {
	return digestWorkers.pool.stats;
}

/** Raw SHA-256 only in a Worker. A path is opened there; Blobs are structured-cloned, never read here. */
export async function digestAttachment(
	input: Blob | string,
	options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
	options.signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs ?? ATTACHMENT_DIGEST_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? ATTACHMENT_DIGEST_MAX_BYTES;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
		throw new RangeError("Attachment digest timeout must be between 1 and 2147483647 ms");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ATTACHMENT_DIGEST_MAX_BYTES)
		throw new RangeError("Attachment digest maxBytes must be between 0 and 2 GiB");
	let request: DigestRequest;
	let bytes: number;
	if (typeof input === "string") {
		if (!input || input.includes("\0"))
			throw new TypeError("Attachment digest requires a file path");
		request = { path: input, maxBytes };
		// The queue retains only this path, not the file's contents. No main-thread stat/read.
		bytes = input.length * 3;
	} else {
		if (!(input instanceof Blob))
			throw new TypeError("Attachment digest requires a Blob or file path");
		if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxBytes)
			throw new AppError(
				"Attachment exceeds digest byte budget",
				413,
				"ATTACHMENT_DIGEST_TOO_LARGE",
			);
		request = { blob: input, maxBytes };
		bytes = input.size;
	}
	try {
		return await digestWorkers.pool.run(request, {
			signal: options.signal,
			deadlineAt: Date.now() + timeoutMs,
			bytes,
		});
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
			throw new AppError("Attachment digest workers are busy", 429, "ATTACHMENT_DIGEST_BUSY");
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_TIMEOUT")
			throw new AppError("Attachment digest timed out", 504, "ATTACHMENT_DIGEST_TIMEOUT");
		throw error;
	}
}

async function createDigestWorker(
	context: WorkerTaskContext,
): Promise<PoolWorker<DigestRequest, string>> {
	const { handle } = await connectCompiledWorker(attachmentDigestWorkerSpecifiers(), {
		signal: context.signal,
		deadlineAt: context.deadlineAt,
		timeoutMs: ATTACHMENT_DIGEST_TIMEOUT_MS,
		sendPing: false,
	});
	return {
		get closed() {
			return handle.closed;
		},
		close: () => handle.close(),
		run: (request, task) => receiveDigest(handle, request, task.signal),
	};
}

/** The pool owns budgets/cleanup and the Handle owns termination; no recovery computes locally. */
function receiveDigest(
	handle: DigestWorkerHandle,
	request: DigestRequest,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const worker = handle.resource;
		let settled = false;
		const finish = (digest?: string, error?: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("messageerror", onError);
			worker.off("exit", onExit);
			if (digest !== undefined) resolve(digest);
			else reject(error);
		};
		const onAbort = () => finish(undefined, signal.reason);
		const onError = (error: Error) => finish(undefined, error);
		const onExit = (code: number) =>
			finish(
				undefined,
				new AppError(`Attachment digest worker exited (${code})`, 503, "ATTACHMENT_DIGEST_FAILED"),
			);
		const onMessage = (message: DigestReply) => {
			if (message?.ready === true) return;
			if (typeof message?.digest === "string" && /^[a-f0-9]{64}$/.test(message.digest))
				finish(message.digest);
			else
				finish(
					undefined,
					new AppError(
						message?.error ?? "Attachment digest worker returned an invalid result",
						message?.tooLarge ? 413 : 422,
						message?.tooLarge ? "ATTACHMENT_DIGEST_TOO_LARGE" : "ATTACHMENT_DIGEST_FAILED",
					),
				);
		};
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("messageerror", onError);
		worker.on("exit", onExit);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		else {
			try {
				worker.postMessage(request);
			} catch (error) {
				finish(undefined, error);
			}
		}
	});
}
