/**
 * Document preview worker client.
 *
 * Every parse and every asset read runs in a worker, never on the main thread. There is
 * deliberately NO inline fallback: if the worker cannot be created, crashes, or times out, the
 * request fails explicitly (Worker 隔离 铁律). A reduced-batch or `await` variant on the main
 * thread would still block every HTTP/WebSocket/agent caller, which is the problem this module
 * exists to avoid.
 *
 * Modelled on `lib/agent/request-json.ts`: same pool, same "reply must carry my requestId"
 * discipline, same refusal to let a stale frame consume this caller's budget.
 */

import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../worker-runtime/pool";
import type { DocumentParseOutcome } from "./types";

/** Parse budget: generous for a 25 MB document, far below any request timeout. */
const PARSE_TIMEOUT_MS = 20_000;
/** One picture read re-walks the document, so it shares the same budget. */
const ASSET_TIMEOUT_MS = 20_000;

type WorkerRequest =
	| { requestId: string; action: "preview"; filePath: string }
	| { requestId: string; action: "asset"; filePath: string; assetId: string };

interface WorkerReply {
	requestId?: string;
	ready?: boolean;
	ok?: boolean;
	outcome?: DocumentParseOutcome;
	asset?: { bytes: Uint8Array; mime: string } | null;
	error?: string;
}

function createPool() {
	return new WorkerPool<WorkerRequest, WorkerReply>({
		concurrency: 1,
		maxQueued: 8,
		idleTimeoutMs: 30_000,
		create: connectWorker,
		onTaskComplete: (timing) => {
			if (timing.outcome === "error") {
				logger.warn("Document preview worker task failed", {
					kind: timing.kind,
					execMs: timing.execMs,
					totalMs: timing.totalMs,
				});
			}
		},
	});
}

const owner = hotSafe("narrafork.documentPreview.workers.v1", () => ({
	pool: createPool(),
	closed: false,
}));

function assertOpen(): void {
	if (owner.closed) throw new Error("Document preview workers are closed");
}

/** Permanent latch: after this, document previews fail rather than run on the main thread. */
export function closeDocumentPreviewWorkers(): Promise<void> {
	owner.closed = true;
	return owner.pool.close(new Error("Document preview workers are closed"));
}

export async function resetDocumentPreviewWorkersForTests(): Promise<void> {
	await closeDocumentPreviewWorkers();
	owner.pool = createPool();
	owner.closed = false;
}

async function connectWorker(
	context: WorkerTaskContext,
): Promise<PoolWorker<WorkerRequest, WorkerReply>> {
	const { worker, handle } = await connectCompiledWorker(
		compiledWorkerSpecifiers("lib/document-preview/worker.ts", "./worker.ts", import.meta.url),
		{
			signal: context.signal,
			deadlineAt: Math.min(Date.now() + 5_000, context.deadlineAt),
		},
	);
	worker.unref();

	return {
		get closed() {
			return handle.closed;
		},
		close: () => handle.close(),
		run: (request, { requestId, signal }) =>
			new Promise<WorkerReply>((accept, fail) => {
				let finished = false;
				const finish = (reply?: WorkerReply, error?: unknown, stop = false) => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					worker.off("message", receive);
					worker.off("error", failWorker);
					worker.off("messageerror", failWorker);
					worker.off("exit", failWorker);
					signal.removeEventListener("abort", abort);
					if (reply !== undefined) accept(reply);
					else if (stop) void handle.close().then(() => fail(error), fail);
					else fail(error);
				};
				const timeoutMs = request.action === "asset" ? ASSET_TIMEOUT_MS : PARSE_TIMEOUT_MS;
				const invalid = () =>
					finish(undefined, new Error("Invalid document preview worker response"), true);
				const receive = (response: unknown) => {
					const reply = response as WorkerReply | undefined;
					if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
						invalid();
						return;
					}
					// A stale frame cannot consume this caller's listener or budget.
					if (reply.requestId !== requestId) return;
					finish(reply);
				};
				const failWorker = () =>
					finish(undefined, new Error("Document preview worker exited"), true);
				const abort = () => finish(undefined, signal.reason, true);
				const timer = setTimeout(
					() => finish(undefined, new Error("Document preview timed out"), true),
					timeoutMs,
				);
				worker.on("message", receive);
				worker.once("error", failWorker);
				worker.once("messageerror", failWorker);
				worker.once("exit", failWorker);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				else {
					try {
						worker.postMessage({ ...request, requestId });
					} catch (error) {
						finish(undefined, error, true);
					}
				}
			}),
	};
}

/** Parse a document for read-only preview. Throws when the worker is unavailable or failed. */
export async function requestDocumentPreview(
	filePath: string,
	signal?: AbortSignal,
): Promise<DocumentParseOutcome> {
	assertOpen();
	const reply = await owner.pool.run(
		{ requestId: "", action: "preview", filePath },
		{ signal, deadlineAt: Infinity },
	);
	if (reply.ok !== true) throw new Error(reply.error ?? "Document preview failed");
	if (!reply.outcome) throw new Error("Document preview returned no result");
	return reply.outcome;
}

/** Read one embedded picture. `null` means the id does not belong to this document. */
export async function requestDocumentAsset(
	filePath: string,
	assetId: string,
	signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
	assertOpen();
	const reply = await owner.pool.run(
		{ requestId: "", action: "asset", filePath, assetId },
		{ signal, deadlineAt: Infinity },
	);
	if (reply.ok !== true) throw new Error(reply.error ?? "Document asset read failed");
	return reply.asset ?? null;
}
