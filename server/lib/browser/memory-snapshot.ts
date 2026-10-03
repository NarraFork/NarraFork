import { unlink } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { isCompiledRuntime } from "../runtime-target";
import {
	boundedCleanup,
	SNAPSHOT_CLEANUP_MS,
	SNAPSHOT_MAX_BYTES,
	SnapshotError,
	type SnapshotStage,
} from "./memory-snapshot-stream";
import type { SnapshotRequest } from "./memory-snapshot-worker";

export interface HeapSnapshotOptions extends SnapshotRequest {
	signal: AbortSignal;
}
export function snapshotWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return (
		compiled
			? [
					"./lib/browser/memory-snapshot-worker.js",
					"./server/lib/browser/memory-snapshot-worker.js",
					"./memory-snapshot-worker.js",
				]
			: ["./memory-snapshot-worker.ts"]
	).map((path) => new URL(path, moduleUrl).href);
}
export function snapshotWorkerEntryPoint(specifier: string): string | URL {
	const url = new URL(specifier);
	if (url.protocol === "file:" && /^\/[a-z]:\/(?:~BUN|%7eBUN)\/root\//i.test(url.pathname)) {
		return decodeURIComponent(url.pathname.slice(1));
	}
	return url;
}
type SnapshotReply =
	| { kind: "ready" }
	| { kind: "done"; fileSize: number }
	| { kind: "failed"; stage: SnapshotStage };
export interface SnapshotWorker {
	on(event: "message", listener: (message: SnapshotReply) => void): unknown;
	on(event: "error" | "exit", listener: () => void): unknown;
	removeAllListeners(): unknown;
	postMessage(value: unknown): void;
	terminate(): Promise<number>;
}
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
let snapshotActive = false;

/** Test seam also exercises real admission, cancellation and startup candidate fallback. */
export function createSnapshotExporter(
	dependencies: {
		spawn?: (specifier: string) => SnapshotWorker;
		specifiers?: () => string[];
		unlink?: (path: string) => Promise<void>;
	} = {},
) {
	return async (opts: HeapSnapshotOptions): Promise<{ fileSize: number }> => {
		if (snapshotActive) throw new SnapshotError("busy");
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
		snapshotActive = true;
		let worker: SnapshotWorker | undefined;
		let dispatched = false;
		let success = false;
		const deadline = Date.now() + opts.timeoutMs;
		const { signal, ...request } = opts;
		request.maxBytes = Math.min(request.maxBytes, SNAPSHOT_MAX_BYTES);
		try {
			for (const specifier of (dependencies.specifiers ?? snapshotWorkerSpecifiers)()) {
				if (signal.aborted) throw new SnapshotError("cancelled");
				if (Date.now() >= deadline) throw new SnapshotError("timeout");
				try {
					worker = (dependencies.spawn ?? ((path) => new Worker(snapshotWorkerEntryPoint(path))))(
						specifier,
					);
					const current = worker;
					const result = await new Promise<{ fileSize: number }>((resolve, reject) => {
						let settled = false;
						const finish = (error?: SnapshotError, fileSize?: number) => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							signal.removeEventListener("abort", abort);
							current.removeAllListeners();
							if (error) reject(error);
							else resolve({ fileSize: fileSize as number });
						};
						const abort = () => finish(new SnapshotError("cancelled"));
						const timer = setTimeout(
							() => finish(new SnapshotError("timeout")),
							deadline - Date.now(),
						);
						signal.addEventListener("abort", abort, { once: true });
						current.on("message", (message) => {
							if (settled) return;
							if (message?.kind === "ready" && !dispatched) {
								dispatched = true;
								try {
									current.postMessage({ kind: "start", opts: request });
								} catch {
									finish(new SnapshotError("worker"));
								}
							} else if (message?.kind === "done" && dispatched) {
								if (
									Number.isSafeInteger(message.fileSize) &&
									message.fileSize > 0 &&
									message.fileSize <= request.maxBytes
								)
									finish(undefined, message.fileSize);
								else finish(new SnapshotError("worker"));
							} else if (message?.kind === "failed") {
								finish(new SnapshotError(STAGES.has(message.stage) ? message.stage : "worker"));
							}
						});
						current.on("error", () => finish(new SnapshotError("startup")));
						current.on("exit", () => finish(new SnapshotError(dispatched ? "worker" : "startup")));
						if (signal.aborted) abort();
					});
					success = true;
					return result;
				} catch (error) {
					if (worker) {
						await stopWorker(worker);
						worker = undefined;
					}
					if (dispatched || signal.aborted || Date.now() >= deadline)
						throw error instanceof SnapshotError ? error : new SnapshotError("worker");
				}
			}
			throw new SnapshotError("startup");
		} finally {
			try {
				if (worker) await stopWorker(worker);
				if (!success && dispatched) {
					const remove = dependencies.unlink ?? unlink;
					await boundedCleanup(() =>
						Promise.all([
							remove(`${opts.savePath}.partial`).catch(() => {}),
							remove(opts.savePath).catch(() => {}),
						]),
					);
				}
			} finally {
				snapshotActive = false;
			}
		}
	};
}

async function stopWorker(worker: SnapshotWorker): Promise<void> {
	worker.removeAllListeners();
	// Never surface raw worker exceptions (they may contain endpoints or heap data).
	worker.on("error", () => {});
	try {
		worker.postMessage({ kind: "cancel" });
	} catch {}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, SNAPSHOT_CLEANUP_MS);
		worker.on("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	await boundedCleanup(() => worker.terminate());
	worker.removeAllListeners();
}

export const exportHeapSnapshot = createSnapshotExporter();
