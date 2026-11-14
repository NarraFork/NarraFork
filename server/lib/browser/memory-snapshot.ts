import { unlink } from "node:fs/promises";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { isCompiledRuntime } from "../runtime-target";
import { WorkerCleanupError, type WorkerHandle } from "../worker-runtime/lifecycle";
import type { TaskQueuePermit } from "../worker-runtime/queue";
import { memoryDiagnosticQueue, trackMemoryDiagnostic, waitForMemory } from "./memory-job";
import {
	SNAPSHOT_CLEANUP_MS,
	SNAPSHOT_MAX_BYTES,
	SnapshotError,
	type SnapshotStage,
} from "./memory-snapshot-stream";
import type { SnapshotRequest } from "./memory-snapshot-worker";

export interface HeapSnapshotOptions extends SnapshotRequest {
	signal: AbortSignal;
	/** Retain session/diagnostic ownership if the bounded response precedes physical cleanup. */
	onCleanup?: (cleanup: Promise<void>) => void;
}
export function snapshotWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"lib/browser/memory-snapshot-worker.ts",
		"./memory-snapshot-worker.ts",
		moduleUrl,
		compiled,
	);
}
type SnapshotReply =
	| { kind: "ready" }
	| { kind: "done"; fileSize: number }
	| { kind: "failed"; stage: SnapshotStage };
const STAGES = new Set<SnapshotStage>([
	"busy",
	"input",
	"startup",
	"connect",
	"target",
	"capture",
	"bytes",
	"queue",
	"write",
	"finalize",
	"cancelled",
	"timeout",
	"worker",
]);

/** Public queue owns admission; the connector/handle own readiness and actual native exit. */
export function createSnapshotExporter(
	dependencies: {
		specifiers?: () => string[];
		unlink?: (path: string) => Promise<void>;
		cleanupMs?: number;
	} = {},
) {
	return async (opts: HeapSnapshotOptions): Promise<{ fileSize: number }> => {
		if (
			!opts.targetId ||
			!opts.wsEndpoint ||
			!opts.savePath ||
			!Number.isSafeInteger(opts.maxBytes) ||
			opts.maxBytes <= 0 ||
			!Number.isFinite(opts.timeoutMs) ||
			opts.timeoutMs <= 0
		)
			throw new SnapshotError("input");
		if (opts.signal.aborted) throw new SnapshotError("cancelled");
		const controller = new AbortController();
		const abort = () => controller.abort();
		opts.signal.addEventListener("abort", abort, { once: true });
		let complete!: () => void;
		const done = new Promise<void>((resolve) => {
			complete = resolve;
		});
		try {
			trackMemoryDiagnostic({ controller, done });
		} catch {
			opts.signal.removeEventListener("abort", abort);
			throw new SnapshotError("busy");
		}
		let permit: TaskQueuePermit | undefined;
		let handle: WorkerHandle<import("node:worker_threads").Worker> | undefined;
		let startup: Promise<unknown> | undefined;
		let dispatched = false;
		let success = false;
		let result: { fileSize: number } | undefined;
		let failure: unknown;
		let cleanupTimedOut = false;
		const deadline = Date.now() + opts.timeoutMs;
		let timedOut = false;
		const deadlineTimer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, opts.timeoutMs);
		const cleanupMs = dependencies.cleanupMs ?? SNAPSHOT_CLEANUP_MS;
		const signal = controller.signal;
		const { signal: _signal, onCleanup: _cleanup, ...request } = opts;
		request.maxBytes = Math.min(request.maxBytes, SNAPSHOT_MAX_BYTES);
		let removeListeners = () => {};
		try {
			try {
				permit = await memoryDiagnosticQueue.acquire({ signal, deadlineAt: deadline });
			} catch {
				throw new SnapshotError(signal.aborted ? "cancelled" : "busy");
			}
			if (signal.aborted) throw new SnapshotError(timedOut ? "timeout" : "cancelled");
			startup = connectCompiledWorker((dependencies.specifiers ?? snapshotWorkerSpecifiers)(), {
				signal,
				deadlineAt: deadline,
				timeoutMs: opts.timeoutMs,
				sendPing: false,
				isReady: (message) => (message as SnapshotReply)?.kind === "ready",
			}).then(
				(connected) => {
					handle = connected.handle;
					return connected;
				},
				(error) => {
					if (error instanceof WorkerCleanupError) handle = error.handle as typeof handle;
					throw error;
				},
			);
			try {
				await waitForMemory(startup, signal);
			} catch {
				throw new SnapshotError(
					timedOut
						? "timeout"
						: signal.aborted
							? "cancelled"
							: Date.now() >= deadline
								? "timeout"
								: "startup",
				);
			}
			if (signal.aborted) throw new SnapshotError(timedOut ? "timeout" : "cancelled");
			if (!handle) throw new SnapshotError("startup");
			const worker = handle.resource;
			result = await new Promise<{ fileSize: number }>((resolve, reject) => {
				let settled = false;
				const finish = (error?: SnapshotError, fileSize?: number) => {
					if (settled) return;
					settled = true;
					removeListeners();
					if (error) reject(error);
					else resolve({ fileSize: fileSize as number });
				};
				const cancelled = () => finish(new SnapshotError(timedOut ? "timeout" : "cancelled"));
				const timer = setTimeout(
					() => finish(new SnapshotError("timeout")),
					Math.max(1, deadline - Date.now()),
				);
				const message = (reply: SnapshotReply) => {
					if (reply?.kind === "done") {
						if (
							Number.isSafeInteger(reply.fileSize) &&
							reply.fileSize > 0 &&
							reply.fileSize <= request.maxBytes
						)
							finish(undefined, reply.fileSize);
						else finish(new SnapshotError("worker"));
					} else if (reply?.kind === "failed")
						finish(new SnapshotError(STAGES.has(reply.stage) ? reply.stage : "worker"));
				};
				const failure = () => finish(new SnapshotError("worker"));
				removeListeners = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", cancelled);
					worker.off("message", message);
					worker.off("error", failure);
					worker.off("exit", failure);
				};
				worker.on("message", message);
				worker.on("error", failure);
				worker.on("exit", failure);
				signal.addEventListener("abort", cancelled, { once: true });
				try {
					dispatched = true;
					worker.postMessage({ kind: "start", opts: request });
				} catch {
					failure();
				}
				if (signal.aborted) cancelled();
			});
			success = true;
		} catch (error) {
			failure = error;
		} finally {
			clearTimeout(deadlineTimer);
			removeListeners();
			const cleanup = (async () => {
				try {
					await startup?.catch(() => {});
					if (handle) {
						try {
							handle.resource.postMessage({ kind: "cancel" });
						} catch {}
						// Grace is bounded, native termination is not confused with its response budget.
						await waitForMemory(handle.exited, AbortSignal.timeout(cleanupMs)).catch(() => {});
						await handle.close().catch(() => {});
						await handle.exited;
					}
					if (!success && dispatched) {
						const remove = dependencies.unlink ?? unlink;
						await Promise.all([
							remove(`${opts.savePath}.partial`).catch(() => {}),
							remove(opts.savePath).catch(() => {}),
						]);
					}
				} finally {
					opts.signal.removeEventListener("abort", abort);
					permit?.release();
					complete();
				}
			})();
			opts.onCleanup?.(cleanup);
			try {
				await waitForMemory(cleanup, AbortSignal.timeout(cleanupMs * 3));
			} catch {
				if (success) {
					success = false;
					cleanupTimedOut = true;
				}
			}
		}
		if (cleanupTimedOut) throw new SnapshotError("timeout");
		if (!success) throw failure;
		if (!result) throw new SnapshotError("worker");
		return result;
	};
}

export const exportHeapSnapshot = createSnapshotExporter();
