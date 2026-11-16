import { parentPort, workerData } from "node:worker_threads";
import { canWriteOptionalDiskData } from "./disk-safety";
import { AppError } from "./errors";
import { logger } from "./logger";
import {
	RECORDING_QUEUE_BYTES,
	type RecorderMessage,
	type RecorderReply,
} from "./request-recorder-protocol";
import { RequestRecorderStore } from "./request-recorder-store";
import { settings } from "./settings";
import { TaskQueue } from "./worker-runtime/queue";

const store = new RequestRecorderStore((workerData as { home: string }).home, () =>
	canWriteOptionalDiskData((workerData as { home: string }).home),
);
// The sender's 64 inflight frames bound the domain mailbox; maintenance occupies at most one
// additional entry. The common queue owns FIFO admission instead of an unbounded Promise tail.
const ordered = new TaskQueue({
	concurrency: 1,
	maxQueued: 64,
	maxQueuedBytes: RECORDING_QUEUE_BYTES,
});
const queries = new TaskQueue({ concurrency: 2, maxQueued: 0 });
const controllers = new Map<number, AbortController>();
const cancelled = new Set<number>();
function warn(message: string, elapsedMs?: number): void {
	try {
		logger.warn(message, { elapsedMs: elapsedMs ?? 0 });
	} catch {}
}
function reply(id: number, value?: unknown, error?: unknown): void {
	const message: RecorderReply = error
		? {
				id,
				error: {
					message:
						error instanceof AppError ? error.message.slice(0, 2048) : "Recording operation failed",
					status: error instanceof AppError ? error.statusCode : 500,
					code: error instanceof AppError ? error.code : "RECORDING_FAILED",
				},
			}
		: { id, value };
	parentPort?.postMessage(message);
}
function query(message: RecorderMessage): void {
	if (queries.stats.active >= 2) {
		reply(message.id, undefined, new AppError("Recording queries are busy", 429, "RECORDING_BUSY"));
		return;
	}
	const controller = new AbortController();
	controllers.set(message.id, controller);
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
	const started = performance.now();
	void queries
		.run(
			async () => {
				try {
					const op = message.op;
					const value =
						op.type === "list"
							? await store.list(op.narratorId, op.cursor, op.limit, signal)
							: op.type === "detail"
								? await store.detail(op.narratorId, op.requestId, signal)
								: undefined;
					reply(message.id, value);
				} catch (error) {
					reply(message.id, undefined, error);
				} finally {
					controllers.delete(message.id);
					const elapsedMs = performance.now() - started;
					if (elapsedMs > 1000) warn("Slow request recording query", elapsedMs);
				}
			},
			{ deadlineAt: Infinity },
		)
		.catch((error: unknown) => {
			controllers.delete(message.id);
			reply(message.id, undefined, error);
		});
}
parentPort?.on("message", (message: RecorderMessage | { cancel: number }) => {
	if ("cancel" in message) {
		const controller = controllers.get(message.cancel);
		if (controller) controller.abort();
		else {
			if (cancelled.size >= 128) {
				const oldest = cancelled.values().next().value;
				if (oldest !== undefined) cancelled.delete(oldest);
			}
			cancelled.add(message.cancel);
		}
		return;
	}
	if (message.op.type === "list") {
		if (cancelled.delete(message.id)) {
			reply(
				message.id,
				undefined,
				new AppError("Recording listing cancelled", 499, "RECORDING_CANCELLED"),
			);
			return;
		}
		// Read-only directory queries cannot stall the ordered transport capture queue.
		query(message);
		return;
	}
	const bytes =
		message.op.type === "chunk"
			? message.op.data.byteLength +
				Buffer.byteLength(JSON.stringify({ ...message.op, data: undefined }))
			: Buffer.byteLength(JSON.stringify(message.op));
	void ordered
		.run(
			async () => {
				if (cancelled.delete(message.id)) {
					reply(message.id, undefined, new Error("Recording operation cancelled"));
					return;
				}
				const started = performance.now();
				try {
					if (message.op.type === "configure" && message.op.diskSafety)
						settings.diskSafety = { ...message.op.diskSafety };
					if (message.op.type === "detail") {
						// Detail starts after prior captures, but reads do not block subsequent frames.
						query(message);
					} else if (message.op.type === "save-specific") {
						const controller = new AbortController();
						controllers.set(message.id, controller);
						try {
							const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
							reply(message.id, await store.execute(message.op, signal));
						} finally {
							controllers.delete(message.id);
						}
					} else if (message.op.type === "archive") {
						const controller = new AbortController();
						controllers.set(message.id, controller);
						const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
						const job = await store.prepareArchive(
							message.op.narratorId,
							message.op.saveId,
							signal,
						);
						// Store archive reservations keep the existing two-compressor safety budget.
						void store
							.buildArchive(job, signal)
							.then(
								(value) => reply(message.id, value),
								(error) => reply(message.id, undefined, error),
							)
							.finally(() => controllers.delete(message.id))
							.catch(() => warn("Request recording archive reply failed"));
					} else reply(message.id, await store.execute(message.op));
				} catch (error) {
					controllers.delete(message.id);
					reply(message.id, undefined, error);
				} finally {
					const elapsedMs = performance.now() - started;
					if (elapsedMs > 1000) warn("Slow request recorder operation", elapsedMs);
				}
			},
			{ deadlineAt: Infinity, bytes },
		)
		.catch((error: unknown) => reply(message.id, undefined, error));
});
let flushing = false;
const checkpoint = setInterval(() => {
	if (flushing) return;
	flushing = true;
	void ordered
		.run(() => store.flush(), { deadlineAt: Infinity })
		.catch(() => warn("Request recording checkpoint failed"))
		.finally(() => {
			flushing = false;
		});
}, 250);
checkpoint.unref();
parentPort?.postMessage({ ready: true });
