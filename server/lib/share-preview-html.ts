import { SHARE_HTML_TIMEOUT_MS } from "../../shared/share-preview";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "./compiled-worker";
import { AppError } from "./errors";
import { hotSafe } from "./hot-safe";
import { logger } from "./logger";
import { isCompiledRuntime } from "./runtime-target";
import type { WorkerHandle } from "./worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "./worker-runtime/pool";
import { TaskQueueError } from "./worker-runtime/queue";

export function shareHtmlWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"lib/share-preview-worker.ts",
		"./share-preview-worker.ts",
		moduleUrl,
		compiled,
	);
}
function createPool() {
	return new WorkerPool<string, string>({
		concurrency: 2,
		maxQueued: 0,
		maxQueuedBytes: 0,
		timeoutMs: SHARE_HTML_TIMEOUT_MS,
		// The existing worker accepts exactly one path, then closes its parent port.
		reuse: false,
		create: createHtmlWorker,
	});
}
const htmlWorkers = hotSafe("narrafork.sharePreviewHtmlWorkers", () => ({ pool: createPool() }));

/** Stop admission, cancel active jobs and wait for their actual thread exits. Never reopens. */
export function closeSharePreviewHtmlWorkers(): Promise<void> {
	return htmlWorkers.pool.close(
		new AppError("HTML preview worker is unavailable", 503, "SHARE_PREVIEW_FAILED"),
	);
}

/** Explicit test isolation only; production close must not implicitly recreate the pool. */
export async function resetSharePreviewHtmlWorkersForTests(): Promise<void> {
	await closeSharePreviewHtmlWorkers();
	htmlWorkers.pool = createPool();
}

/** Public endpoint: two one-shot workers, no waiting queue; startup shares the total budget. */
export async function renderShareHtml(path: string, externalSignal: AbortSignal): Promise<string> {
	externalSignal.throwIfAborted();
	const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(SHARE_HTML_TIMEOUT_MS)]);
	const started = performance.now();
	try {
		return await htmlWorkers.pool.run(path, {
			signal,
			deadlineAt: Date.now() + SHARE_HTML_TIMEOUT_MS,
			// Only the path is retained on the main thread; a UTF-8 upper bound is O(1).
			bytes: path.length * 3,
		});
	} catch (error) {
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
			throw new AppError("Preview busy; please retry", 429, "SHARE_PREVIEW_BUSY");
		if (signal.aborted || (error instanceof TaskQueueError && error.code === "TASK_QUEUE_TIMEOUT"))
			throw new AppError("HTML preview cancelled or timed out", 504, "SHARE_PREVIEW_TIMEOUT");
		throw error;
	} finally {
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 250) logger.warn("Slow share HTML preview", { elapsedMs });
	}
}

type HtmlWorkerHandle = ReturnType<typeof WorkerHandle.thread>;
type HtmlWorkerMessage = { ready?: boolean; html?: string; error?: string };

async function createHtmlWorker(context: WorkerTaskContext): Promise<PoolWorker<string, string>> {
	const { handle } = await connectCompiledWorker(shareHtmlWorkerSpecifiers(), {
		signal: context.signal,
		deadlineAt: context.deadlineAt,
		timeoutMs: SHARE_HTML_TIMEOUT_MS,
		// The worker reports ready after installing its one-shot path handler. A startup ping
		// would consume that handler as a business request, so only await its active handshake.
		sendPing: false,
	});
	return {
		get closed() {
			return handle.closed;
		},
		close: () => handle.close(),
		run: (path, task) =>
			receive(
				handle,
				task.signal,
				(message) => {
					if (message.ready === true) return;
					if (typeof message.html === "string") return { value: message.html };
					throw new AppError(message.error ?? "HTML preview failed", 422, "SHARE_PREVIEW_FAILED");
				},
				() => handle.resource.postMessage(path),
			),
	};
}

/** Domain wire handling only; the pool owns admission/deadlines and the handle owns termination. */
function receive<T>(
	handle: HtmlWorkerHandle,
	signal: AbortSignal,
	accept: (message: HtmlWorkerMessage) => { value: T } | undefined,
	dispatch?: () => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const worker = handle.resource;
		let settled = false;
		const finish = (result?: { value: T }, error?: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			worker.off("error", onError);
			worker.off("messageerror", onError);
			worker.off("exit", onExit);
			worker.off("message", onMessage);
			if (result) resolve(result.value);
			else reject(error);
		};
		const onAbort = () => finish(undefined, signal.reason);
		const onError = (error: Error) => finish(undefined, error);
		const onExit = (code: number) =>
			finish(
				undefined,
				new AppError(`HTML preview worker exited (${code})`, 500, "SHARE_PREVIEW_FAILED"),
			);
		const onMessage = (message: HtmlWorkerMessage) => {
			try {
				const result = accept(message);
				if (result) finish(result);
			} catch (error) {
				finish(undefined, error);
			}
		};
		worker.on("error", onError);
		worker.on("messageerror", onError);
		worker.on("exit", onExit);
		worker.on("message", onMessage);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		else {
			try {
				dispatch?.();
			} catch (error) {
				finish(undefined, error);
			}
		}
	});
}
