import type { Worker } from "node:worker_threads";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import {
	compiledWorkerSpecifiers,
	connectCompiledWorker,
	WorkerStartupError,
} from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isCompiledRuntime } from "../lib/runtime-target";
import { currentSqlTraceSpan } from "../lib/sql-trace";
import { WorkerCleanupError, type WorkerHandle } from "../lib/worker-runtime/lifecycle";
import {
	type PoolWorker,
	WorkerPool,
	WorkerPoolError,
	type WorkerTaskContext,
} from "../lib/worker-runtime/pool";
import { TaskQueueError } from "../lib/worker-runtime/queue";
import type { RevertSelectionResult } from "./revert-selection-service";
import type { TransactionManifestRequest } from "./revert-transaction-manifest-worker";
import {
	REVERT_MANIFEST_WORKER_VERSION,
	type TransactionManifestWorkerRequest,
} from "./revert-transaction-worker-protocol";

export class RevertTransactionError extends AppError {
	constructor(code: string) {
		super(`Local revert transaction refused: ${code}`, 409, `REVERT_TRANSACTION_${code}`);
		this.name = "RevertTransactionError";
	}
}

/** Compiled modules share the binary's import.meta.url; extra entries become .js. */
export function revertManifestWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"services/revert-transaction-manifest-worker.ts",
		"./revert-transaction-manifest-worker.ts",
		moduleUrl,
		compiled,
	);
}

const READY_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
interface WorkerOptions {
	/** Trusted test seams, never supplied by HTTP. These use an isolated one-shot pool. */
	specifiers?: readonly string[];
	readyTimeoutMs?: number;
	/** When known by the owner, queueing and execution share its absolute deadline. */
	deadlineAt?: number;
}

function ready(message: unknown): boolean {
	return (
		!!message &&
		typeof message === "object" &&
		!Array.isArray(message) &&
		"type" in message &&
		message.type === "revert-manifest-worker-ready" &&
		"version" in message &&
		message.version === REVERT_MANIFEST_WORKER_VERSION
	);
}

/** Only a scalar response envelope is inspected here; manifest computation stays off-thread. */
class ManifestWorker implements PoolWorker<TransactionManifestWorkerRequest, unknown> {
	private stopping = false;
	private pending:
		| {
				requestId: string;
				resolve: (value: unknown) => void;
				reject: (error: unknown) => void;
		  }
		| undefined;
	constructor(private readonly handle: WorkerHandle<Worker>) {
		handle.resource.on("message", this.message);
		handle.resource.on("error", this.failed);
		handle.resource.on("messageerror", this.failed);
		handle.resource.on("exit", this.exited);
		handle.resource.unref();
	}
	get closed(): boolean {
		return this.stopping || this.handle.closed;
	}
	private message = (message: unknown) => {
		if (ready(message)) return;
		if (
			!message ||
			typeof message !== "object" ||
			Array.isArray(message) ||
			!("requestId" in message) ||
			typeof message.requestId !== "string" ||
			!message.requestId
		) {
			this.failed(new RevertTransactionError("MANIFEST_WORKER_PROTOCOL"));
			return;
		}
		const pending = this.pending;
		if (!pending || message.requestId !== pending.requestId) return;
		if ("error" in message && typeof message.error === "string" && !("value" in message)) {
			// Never expose parser excerpts, filesystem paths or manifest text through the public error.
			const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(message.error)
				? message.error
				: "INVALID_MANIFEST";
			this.pending = undefined;
			this.handle.resource.unref();
			pending.reject(new RevertTransactionError(code));
		} else if ("value" in message && !("error" in message)) {
			this.pending = undefined;
			this.handle.resource.unref();
			pending.resolve(message.value);
		} else this.failed(new RevertTransactionError("MANIFEST_WORKER_PROTOCOL"));
	};
	private failed = (error: unknown) => {
		this.pending?.reject(
			error instanceof RevertTransactionError
				? error
				: new RevertTransactionError("MANIFEST_WORKER_FAILED"),
		);
		this.pending = undefined;
		void this.close().catch(() => {});
	};
	private exited = () => this.failed(new RevertTransactionError("MANIFEST_WORKER_EXITED"));
	run(packet: TransactionManifestWorkerRequest, context: WorkerTaskContext): Promise<unknown> {
		context.signal.throwIfAborted();
		if (this.closed) return Promise.reject(new RevertTransactionError("MANIFEST_WORKER_FAILED"));
		this.handle.resource.ref();
		return new Promise((resolve, reject) => {
			this.pending = { requestId: packet.requestId, resolve, reject };
			try {
				this.handle.resource.postMessage(packet);
			} catch (error) {
				this.failed(error);
			}
		});
	}
	async close(): Promise<void> {
		this.stopping = true;
		this.pending?.reject(new RevertTransactionError("MANIFEST_WORKER_EXITED"));
		this.pending = undefined;
		await this.handle.close();
		this.handle.resource.off("message", this.message);
		this.handle.resource.off("error", this.failed);
		this.handle.resource.off("messageerror", this.failed);
		this.handle.resource.off("exit", this.exited);
	}
}

function startupError(error: unknown): RevertTransactionError {
	const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
	if (cause instanceof RevertTransactionError) return cause;
	if (cause instanceof WorkerStartupError)
		return new RevertTransactionError(
			cause.code === "TIMEOUT" ? "MANIFEST_WORKER_TIMEOUT" : "MANIFEST_WORKER_EXITED",
		);
	return new RevertTransactionError("MANIFEST_WORKER_FAILED");
}

function createManifestPool(
	specifiers = revertManifestWorkerSpecifiers(),
	readyTimeoutMs = READY_TIMEOUT_MS,
	reuse = true,
) {
	// Correlation metadata only, never a result cache or a reference to the request body.
	const actions = new Map<string, TransactionManifestRequest["action"]>();
	const candidates = specifiers.slice(0, 3);
	const pool = new WorkerPool<TransactionManifestWorkerRequest, unknown>({
		concurrency: 2,
		maxQueued: 8,
		// Existing evidence + manifest bounds admit a full-size legal job without measuring JSON.
		maxQueuedBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes + FILE_CHANGE_LIMITS.blobBytes,
		timeoutMs: FILE_CHANGE_LIMITS.planLifetimeMs,
		idleTimeoutMs: IDLE_TIMEOUT_MS,
		reuse,
		create: async (context) => {
			try {
				const { handle } = await connectCompiledWorker(candidates, {
					signal: context.signal,
					deadlineAt: Math.min(context.deadlineAt, Date.now() + readyTimeoutMs),
					timeoutMs: readyTimeoutMs,
					sendPing: false,
					isReady: (message) => {
						if (!ready(message)) throw new RevertTransactionError("MANIFEST_WORKER_PROTOCOL");
						return true;
					},
				});
				return new ManifestWorker(handle);
			} catch (error) {
				if (!context.signal.aborted) {
					const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
					logger.warn("Revert manifest worker failed before ready", {
						specifier: candidates.join(" | ").slice(0, 1024),
						error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024),
					});
				}
				// The shared pool must retain this startup resource until its actual exit.
				if (error instanceof WorkerCleanupError) throw error;
				throw startupError(error);
			}
		},
		onTaskComplete: (timing) =>
			logger.info("Revert manifest worker timing", {
				pool: "revert-manifest",
				action: timing.kind === "warmup" ? "warmup" : actions.get(timing.requestId),
				parentTraceId: currentSqlTraceSpan()?.id,
				...timing,
				terminateMs: timing.closeMs,
			}),
	});
	return { pool, actions };
}

const manifestWorkers = hotSafe("revert-manifest:pool", () => ({ current: createManifestPool() }));

/** Preview calls this without awaiting it; it does not send a business request or cache a result. */
export function warmRevertManifestWorker(): Promise<void> {
	return manifestWorkers.current.pool.warmup({ deadlineAt: Date.now() + READY_TIMEOUT_MS });
}
export function closeRevertManifestWorkers(): Promise<void> {
	return manifestWorkers.current.pool.close(new RevertTransactionError("MANIFEST_WORKER_FAILED"));
}
export function getRevertManifestWorkerStats() {
	return manifestWorkers.current.pool.stats;
}
export async function resetRevertManifestWorkersForTests(): Promise<void> {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Test-only manifest pool reset");
	await closeRevertManifestWorkers();
	manifestWorkers.current = createManifestPool();
}

/** Scalar lengths only; selected metadata is already bounded by the collector's manifest budget. */
function selectionBytes(selection: RevertSelectionResult): number {
	const history = selection?.history;
	const selector = selection?.selector;
	const selectedIds =
		selector?.kind === "messages"
			? selector.messageIds.length
			: selector?.kind === "tool_calls"
				? selector.toolCallIds.length
				: 0;
	const rows =
		selectedIds +
		(selection?.messageVersions?.length ?? 0) +
		(history?.messages?.length ?? 0) +
		(history?.blocks?.length ?? 0) +
		(history?.toolChanges?.length ?? 0) +
		(history?.associations?.length ?? 0) +
		(selection?.tools?.length ?? 0) +
		(selection?.operations?.length ?? 0) +
		(selection?.effects?.length ?? 0) +
		(selection?.noDiskTools?.length ?? 0) +
		(selection?.issues?.length ?? 0);
	return Math.min(FILE_CHANGE_LIMITS.blobBytes, (rows + 1) * FILE_CHANGE_LIMITS.metadataBytes);
}
function requestBytes(request: TransactionManifestRequest): number {
	if (request.action === "compare")
		return selectionBytes(request.fixed) + selectionBytes(request.current);
	let bytes = FILE_CHANGE_LIMITS.blobBytes;
	if (request.action === "entrypoint") return bytes + request.raw.bytes.byteLength;
	// Only the bounded reference list is visited, never any bytes or parsed manifest fields.
	for (const raw of request.raw) bytes += raw.bytes.byteLength;
	return bytes;
}

export async function runRevertManifestWorker<T>(
	request: TransactionManifestRequest,
	signal: AbortSignal,
	options: WorkerOptions = {},
): Promise<T> {
	signal.throwIfAborted();
	const timeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > READY_TIMEOUT_MS)
		throw new RevertTransactionError("MANIFEST_WORKER_TIMEOUT");
	// Existing trusted fixture entry seams are isolated; production always reuses the pinned pool.
	const isolated = options.specifiers !== undefined || options.readyTimeoutMs !== undefined;
	const state = isolated
		? createManifestPool(
				[...(options.specifiers ?? revertManifestWorkerSpecifiers())],
				timeoutMs,
				false,
			)
		: manifestWorkers.current;
	const packet: TransactionManifestWorkerRequest = { requestId: generateId(), request };
	state.actions.set(packet.requestId, request.action);
	try {
		return (await state.pool.run(packet, {
			signal,
			deadlineAt: options.deadlineAt,
			requestId: packet.requestId,
			bytes: requestBytes(request),
		})) as T;
	} catch (error) {
		if (signal.aborted) throw new RevertTransactionError("MANIFEST_CANCELLED");
		if (error instanceof RevertTransactionError) throw error;
		if (error instanceof TaskQueueError)
			throw new RevertTransactionError(
				error.code === "TASK_QUEUE_FULL" ? "BUSY" : "MANIFEST_WORKER_TIMEOUT",
			);
		if (error instanceof WorkerPoolError || error instanceof WorkerCleanupError)
			throw new RevertTransactionError("MANIFEST_WORKER_FAILED");
		throw startupError(error);
	} finally {
		state.actions.delete(packet.requestId);
		if (isolated) await state.pool.close();
	}
}
