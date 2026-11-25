import {
	type ConnectedWorker,
	compiledWorkerSpecifiers,
	connectCompiledWorker,
} from "../../compiled-worker";
import { hotSafe } from "../../hot-safe";
import { logger } from "../../logger";
import { WorkerCleanupError } from "../../worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../../worker-runtime/pool";
import { TaskQueueError } from "../../worker-runtime/queue";
import type { StructDocument } from "./provider";
import {
	isRecord,
	isStructuralResult,
	STRUCTURAL_GRAMMAR_LIMIT,
	STRUCTURAL_INPUT_LIMIT,
	STRUCTURAL_METADATA_LIMIT,
	type StructuralOperation,
	type StructuralResultMap,
	type StructuralTask,
	type StructuralTaskArgs,
	StructuralWorkerError,
	type StructuralWorkerRequest,
} from "./worker-protocol";

type Request = { generation: number; task: StructuralTask };
type Connector = typeof connectCompiledWorker;
interface Configuration {
	connect: Connector;
	timeoutMs: number;
	readyTimeoutMs: number;
	idleTimeoutMs: number;
}
const defaults = (): Configuration => ({
	connect: (specifiers, options) => connectCompiledWorker(specifiers, options),
	timeoutMs: 15_000,
	readyTimeoutMs: 5_000,
	idleTimeoutMs: 60_000,
});
interface Owner {
	generation: number;
	stopped: boolean;
	pool?: WorkerPool<Request, unknown>;
	/** A rejected drain is deliberately sticky: unconfirmed exit cannot grant capacity. */
	drain: Promise<void>;
	config: Configuration;
}
const owner = hotSafe<Owner>("structural-worker.owner.v1", () => ({
	generation: 0,
	stopped: false,
	drain: Promise.resolve(),
	config: defaults(),
}));

function stale(): StructuralWorkerError {
	return new StructuralWorkerError("STRUCTURAL_WORKER_STALE");
}

function check(generation: number): void {
	if (owner.stopped) throw new StructuralWorkerError("STRUCTURAL_WORKER_CLOSED");
	if (generation !== owner.generation) throw stale();
	if (process.env.NF_STRUCTURAL_WORKER_DISABLED === "1")
		throw new StructuralWorkerError("STRUCTURAL_WORKER_DISABLED");
}

async function waitForDrain(drain: Promise<void>, context: WorkerTaskContext): Promise<void> {
	context.signal.throwIfAborted();
	let abort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(context.signal.reason);
		context.signal.addEventListener("abort", abort, { once: true });
	});
	try {
		await Promise.race([drain, cancelled]);
		context.signal.throwIfAborted();
	} finally {
		context.signal.removeEventListener("abort", abort);
	}
}

/** The transport owns no business computation; every failure remains an explicit failure. */
class StructuralWorker implements PoolWorker<Request, unknown> {
	private failure: StructuralWorkerError | undefined;
	private pending:
		| {
				requestId: string;
				generation: number;
				operation: StructuralTask["operation"];
				resolve(value: unknown): void;
				reject(error: unknown): void;
		  }
		| undefined;
	private closing: Promise<void> | undefined;

	constructor(private readonly connection: ConnectedWorker) {
		connection.worker.on("message", this.onMessage);
		connection.worker.on("error", this.onError);
		connection.worker.on("messageerror", this.onMessageError);
		void connection.handle.exited.then(
			() => this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_EXITED")),
			() => this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_EXITED")),
		);
	}

	get closed(): boolean {
		return this.failure !== undefined || this.connection.handle.closed;
	}

	run(request: Request, context: WorkerTaskContext): Promise<unknown> {
		check(request.generation);
		context.signal.throwIfAborted();
		if (this.closed || this.pending)
			return Promise.reject(this.failure ?? new StructuralWorkerError("STRUCTURAL_WORKER_EXITED"));
		return new Promise((resolve, reject) => {
			this.pending = {
				requestId: context.requestId,
				generation: request.generation,
				operation: request.task.operation,
				resolve,
				reject,
			};
			try {
				this.connection.worker.postMessage({
					requestId: context.requestId,
					generation: request.generation,
					task: request.task,
				} satisfies StructuralWorkerRequest);
			} catch {
				this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL"));
			}
		});
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.failure ??= new StructuralWorkerError("STRUCTURAL_WORKER_EXITED");
			this.pending?.reject(this.failure);
			this.pending = undefined;
			this.closing = this.connection.handle.close().then(() => {
				this.connection.worker.off("message", this.onMessage);
				this.connection.worker.off("error", this.onError);
				this.connection.worker.off("messageerror", this.onMessageError);
			});
		}
		return this.closing;
	}

	private fail(error: StructuralWorkerError): void {
		this.failure ??= error;
		this.pending?.reject(this.failure);
		this.pending = undefined;
		void this.close().catch(() => {});
	}

	private onError = (): void => this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_EXITED"));
	private onMessageError = (): void =>
		this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL"));
	private onMessage = (message: unknown): void => {
		// Only the exact, known ready frame may arrive outside a business RPC.
		if (isRecord(message) && message.ready === true && Object.keys(message).length === 1) return;
		const pending = this.pending;
		if (
			!pending ||
			!isRecord(message) ||
			message.requestId !== pending.requestId ||
			message.generation !== pending.generation ||
			Object.keys(message).some(
				(key) => !["requestId", "generation", "result", "error"].includes(key),
			) ||
			Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
		) {
			this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL"));
			return;
		}
		if (pending.generation !== owner.generation || owner.stopped) {
			this.fail(stale());
			return;
		}
		if (Object.hasOwn(message, "error")) {
			if (
				!isRecord(message.error) ||
				![
					"STRUCTURAL_TASK_FAILED",
					"STRUCTURAL_RESULT_TOO_LARGE",
					"STRUCTURAL_INPUT_TOO_LARGE",
					"STRUCTURAL_WORKER_PROTOCOL",
				].includes(message.error.code as string) ||
				typeof message.error.message !== "string"
			) {
				this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL"));
				return;
			}
			const error = new StructuralWorkerError(
				message.error.code as
					| "STRUCTURAL_TASK_FAILED"
					| "STRUCTURAL_RESULT_TOO_LARGE"
					| "STRUCTURAL_INPUT_TOO_LARGE"
					| "STRUCTURAL_WORKER_PROTOCOL",
			);
			if (message.error.message !== error.message || error.code === "STRUCTURAL_WORKER_PROTOCOL") {
				this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL"));
				return;
			}
			this.pending = undefined;
			pending.reject(error);
			return;
		}
		if (!isStructuralResult(pending.operation, message.result)) {
			this.fail(new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL"));
			return;
		}
		this.pending = undefined;
		pending.resolve(message.result);
	};
}

function getPool(generation: number): WorkerPool<Request, unknown> {
	check(generation);
	if (owner.pool) return owner.pool;
	const drain = owner.drain;
	const config = owner.config;
	owner.pool = new WorkerPool({
		concurrency: 1,
		reservedCapacity: 0,
		maxQueued: 32,
		maxQueuedBytes: 16 * 1024 * 1024,
		timeoutMs: config.timeoutMs,
		idleTimeoutMs: config.idleTimeoutMs,
		reuse: true,
		onTaskComplete: (timing) => {
			if (timing.outcome === "ok" && timing.totalMs < 1_000) return;
			logger.warn("Structural worker task slow or failed", {
				outcome: timing.outcome,
				reused: timing.reused,
				queueMs: timing.queueMs,
				readyMs: timing.readyMs,
				execMs: timing.execMs,
				closeMs: timing.closeMs,
				totalMs: timing.totalMs,
			});
		},
		create: async (context) => {
			try {
				await waitForDrain(drain, context);
				check(generation);
				const connection = await config.connect(
					compiledWorkerSpecifiers(
						"lib/agent/structural/worker-entry.ts",
						"./worker-entry.ts",
						import.meta.url,
					),
					{
						signal: context.signal,
						deadlineAt: Math.min(context.deadlineAt, Date.now() + config.readyTimeoutMs),
						timeoutMs: config.readyTimeoutMs,
						isReady: (message) =>
							isRecord(message) && message.ready === true && Object.keys(message).length === 1,
					},
				);
				return new StructuralWorker(connection);
			} catch (error) {
				// Preserve the pool's resource quarantine contract for unconfirmed startup cleanup.
				if (error instanceof WorkerCleanupError || error instanceof StructuralWorkerError)
					throw error;
				context.signal.throwIfAborted();
				throw new StructuralWorkerError("STRUCTURAL_WORKER_STARTUP");
			}
		},
	});
	return owner.pool;
}

async function submit(task: StructuralTask, bytes: number, signal?: AbortSignal): Promise<unknown> {
	const generation = owner.generation;
	const deadlineAt = Date.now() + owner.config.timeoutMs;
	try {
		check(generation);
		const value = await getPool(generation).run(
			{ generation, task },
			{ signal, deadlineAt, bytes },
		);
		check(generation);
		return value;
	} catch (error) {
		if (owner.stopped) throw new StructuralWorkerError("STRUCTURAL_WORKER_CLOSED");
		if (generation !== owner.generation) throw stale();
		if (signal?.aborted) throw new StructuralWorkerError("STRUCTURAL_WORKER_CANCELLED");
		if (error instanceof StructuralWorkerError) throw error;
		if (error instanceof TaskQueueError)
			throw new StructuralWorkerError(
				error.code === "TASK_QUEUE_FULL"
					? "STRUCTURAL_WORKER_QUEUE_FULL"
					: error.code === "TASK_QUEUE_TIMEOUT"
						? "STRUCTURAL_WORKER_TIMEOUT"
						: "STRUCTURAL_WORKER_CLOSED",
			);
		throw new StructuralWorkerError("STRUCTURAL_WORKER_STARTUP");
	}
}

function snapshotArgs(args?: StructuralTaskArgs): StructuralTaskArgs | undefined {
	if (!args) return undefined;
	const { selector, position } = args;
	if (
		selector?.symbol !== undefined &&
		Buffer.byteLength(selector.symbol) > STRUCTURAL_METADATA_LIMIT
	)
		throw new StructuralWorkerError("STRUCTURAL_INPUT_TOO_LARGE");
	if (
		selector?.kinds &&
		(selector.kinds.length > 64 ||
			selector.kinds.some((value) => typeof value !== "string" || value.length > 32))
	)
		throw new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL");
	return {
		selector: selector
			? { symbol: selector.symbol, kinds: selector.kinds?.slice(), nth: selector.nth }
			: undefined,
		position: position ? { line: position.line, column: position.column } : undefined,
	};
}

export async function runStructuralTask<K extends StructuralOperation>(
	operation: K,
	doc: StructDocument,
	args?: StructuralTaskArgs,
): Promise<StructuralResultMap[K]> {
	const { signal, filePath, text, languageId } = doc;
	check(owner.generation);
	if (signal?.aborted) throw new StructuralWorkerError("STRUCTURAL_WORKER_CANCELLED");
	if (Buffer.byteLength(text) > STRUCTURAL_INPUT_LIMIT)
		throw new StructuralWorkerError("STRUCTURAL_INPUT_TOO_LARGE");
	if (Buffer.byteLength(filePath) + Buffer.byteLength(languageId ?? "") > STRUCTURAL_METADATA_LIMIT)
		throw new StructuralWorkerError("STRUCTURAL_INPUT_TOO_LARGE");
	const safeArgs = snapshotArgs(args);
	let metadata: string;
	try {
		metadata = JSON.stringify({ filePath, languageId, args: safeArgs });
	} catch {
		throw new StructuralWorkerError("STRUCTURAL_WORKER_PROTOCOL");
	}
	if (Buffer.byteLength(metadata) > STRUCTURAL_METADATA_LIMIT)
		throw new StructuralWorkerError("STRUCTURAL_INPUT_TOO_LARGE");
	// Snapshot small options only; escaping source must not reduce the 2MiB UTF-8 text budget.
	const snapshot = JSON.parse(metadata) as {
		filePath: string;
		languageId: string | null;
		args?: StructuralTaskArgs;
	};
	const task: StructuralTask = {
		operation,
		doc: { filePath, text, languageId },
		args: snapshot.args,
	};
	const bytes = text.length * 2 + metadata.length * 2 + 256;
	return (await submit(task, bytes, signal)) as StructuralResultMap[K];
}

export async function verifyStructuralGrammar(
	bytes: Uint8Array,
	signal?: AbortSignal,
): Promise<string | null> {
	check(owner.generation);
	if (signal?.aborted) throw new StructuralWorkerError("STRUCTURAL_WORKER_CANCELLED");
	if (bytes.byteLength > STRUCTURAL_GRAMMAR_LIMIT)
		throw new StructuralWorkerError("STRUCTURAL_INPUT_TOO_LARGE");
	// Do not retain/clone an arbitrarily large backing buffer behind a small typed-array view.
	const snapshot = Uint8Array.from(bytes);
	return (await submit(
		{ operation: "verifyGrammar", bytes: snapshot },
		snapshot.byteLength,
		signal,
	)) as string | null;
}

function retire(reason: StructuralWorkerError): Promise<void> {
	const pool = owner.pool;
	owner.pool = undefined;
	owner.generation++;
	if (pool) owner.drain = Promise.all([owner.drain, pool.close(reason)]).then(() => {});
	void owner.drain.catch(() => {});
	return owner.drain;
}

export function invalidateStructuralWorkers(): void {
	void retire(stale());
}

export function closeStructuralWorkers(): Promise<void> {
	owner.stopped = true;
	return retire(new StructuralWorkerError("STRUCTURAL_WORKER_CLOSED"));
}

/** Explicit fault-injection seam; never used by a production request or fallback. */
export async function __resetStructuralWorkersForTest(
	config: Partial<Configuration> = {},
): Promise<void> {
	await closeStructuralWorkers();
	owner.config = { ...defaults(), ...config };
	owner.stopped = false;
}
