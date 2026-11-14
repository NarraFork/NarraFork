/**
 * Runs `edit-text.ts` jobs where they do not hold up the server.
 *
 * WHY A WORKER
 * ------------
 * Normalizing a block lexes it with marked, more than once when it is not canonical yet. Dense
 * markdown measured 40–180 ms per 16 KiB block and 0.2–1 s for an OutlineEdit call carrying
 * 128 KiB, all of it on the thread that serves every HTTP request, WebSocket and agent loop; some
 * inputs cost far more (unmatched runs of `**`). Agent input is untrusted, so:
 *
 *   - a job carrying at most {@link OUTLINE_EDIT_TEXT_LIMITS.inlineBytes} of text runs inline:
 *     at most a few milliseconds (8 ms for 1 KiB of dense markdown), less than starting the
 *     worker and about what a round trip to a warm one costs;
 *   - a larger one runs on one long-lived worker thread, one job at a time, at most
 *     {@link OUTLINE_EDIT_TEXT_LIMITS.maxQueued} waiting; more are refused rather than queued;
 *   - a job that runs past {@link OUTLINE_EDIT_TEXT_LIMITS.timeoutMs} (or whose caller gives up)
 *     is abandoned and its worker terminated; the next job starts a fresh one;
 *   - a job carrying more than {@link OUTLINE_EDIT_TEXT_LIMITS.maxBytes} is refused up front;
 *   - an idle worker stops after {@link OUTLINE_EDIT_TEXT_LIMITS.idleMs}.
 *
 * The worker runs exactly the functions the inline path runs, so where a job ran never changes
 * its result.
 */
import {
	type ConnectedWorker,
	compiledWorkerSpecifiers,
	connectCompiledWorker,
	WorkerStartupError,
} from "@server/lib/compiled-worker";
import { AppError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { WorkerCleanupError } from "@server/lib/worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, WorkerPoolError } from "@server/lib/worker-runtime/pool";
import { TaskQueueError } from "@server/lib/worker-runtime/queue";
import {
	type EditTextJob,
	type EditTextResult,
	editTextJobBytes,
	runEditTextJob,
} from "./edit-text";
import type { EditTextWorkerRequest } from "./edit-text-worker";
import { OUTLINE_TOOL_TEXT } from "./messages";

export const OUTLINE_EDIT_TEXT_LIMITS = {
	/** Jobs carrying at most this many UTF-8 bytes of text run on the caller's thread. */
	inlineBytes: 1024,
	/** Text one job may carry. */
	maxBytes: 256 * 1024,
	/** A job running longer is abandoned and its worker terminated. */
	timeoutMs: 5_000,
	/** Jobs waiting for the worker; more are refused. */
	maxQueued: 8,
	/** How long an idle worker is kept. */
	idleMs: 30_000,
	/** How long starting the worker may take. */
	startMs: 5_000,
} as const;

export type OutlineEditTextErrorCode =
	| "OUTLINE_TEXT_TOO_LARGE"
	| "OUTLINE_TEXT_BUSY"
	| "OUTLINE_TEXT_TIMEOUT"
	| "OUTLINE_TEXT_FAILED";

/** The text of an OutlineEdit call could not be processed; nothing was written. */
export class OutlineEditTextError extends AppError {
	constructor(code: OutlineEditTextErrorCode, message: string, status: number) {
		super(message, status, code);
		this.name = "OutlineEditTextError";
	}
}

export interface EditTextRunOptions {
	signal?: AbortSignal;
	/** Run on the worker whatever the size (`true`) or inline (`false`); by size by default. */
	worker?: boolean;
	/** Overrides {@link OUTLINE_EDIT_TEXT_LIMITS.timeoutMs} (tests). */
	timeoutMs?: number;
}

interface WorkerJob {
	job: EditTextJob;
	timeoutMs: number;
}
interface ChannelState {
	pool: WorkerPool<WorkerJob, unknown>;
	budgets: Map<string, { timeoutMs: number; bytes: number }>;
	permanent: boolean;
	closing?: Promise<void>;
}

export interface EditTextChannelLimits {
	inlineBytes: number;
	maxBytes: number;
	timeoutMs: number;
	maxQueued: number;
	idleMs: number;
	startMs: number;
}

/**
 * The background channel (outline P2 PR 12b): a worker of its own for large batch work (the
 * import of Dynamic Spec files), so a file of a megabyte never holds up an agent's `OutlineEdit`
 * on the interactive worker above, and is never refused for the interactive size limit. One job
 * at a time, few waiting; the same rules otherwise (a job that runs too long ends its worker,
 * nothing ever falls back to the caller's thread past the inline size).
 */
export const OUTLINE_BACKGROUND_TEXT_LIMITS = {
	inlineBytes: 1024,
	maxBytes: 1024 * 1024,
	timeoutMs: 30_000,
	maxQueued: 2,
	idleMs: 30_000,
	startMs: 5_000,
} as const;

function timeoutError(ms: number): OutlineEditTextError {
	return new OutlineEditTextError("OUTLINE_TEXT_TIMEOUT", OUTLINE_TOOL_TEXT.textTimeout(ms), 504);
}

function abortError(): OutlineEditTextError {
	return new OutlineEditTextError("OUTLINE_TEXT_FAILED", OUTLINE_TOOL_TEXT.textCancelled, 499);
}

export interface EditTextChannel {
	run<J extends EditTextJob>(job: J, options?: EditTextRunOptions): Promise<EditTextResult<J>>;
	/** Tests may reopen only after this barrier; production passes permanent:true. */
	stop(options?: { permanent?: boolean }): Promise<void>;
	resetForTests(): Promise<void>;
}

export type EditTextWorkerConnect = (options: {
	signal: AbortSignal;
	deadlineAt: number;
}) => Promise<Pick<ConnectedWorker, "worker" | "handle">>;

const connectEditTextWorker: EditTextWorkerConnect = (options) =>
	connectCompiledWorker(
		compiledWorkerSpecifiers(
			"services/outline/edit-text-worker.ts",
			"./edit-text-worker.ts",
			import.meta.url,
		),
		options,
	);

/**
 * A channel of its own, for fault-injection tests: `connect` stands for the worker start (one that
 * rejects, never answers, or hands a worker that crashes or hangs). A job such a channel cannot
 * run on its worker fails; nothing ever runs it on the caller's thread past the inline size.
 */
export function createEditTextChannel(
	name: string,
	limits: EditTextChannelLimits,
	connect: EditTextWorkerConnect = connectEditTextWorker,
): EditTextChannel {
	return createChannel(name, limits, connect);
}

function createChannel(
	name: string,
	limits: EditTextChannelLimits,
	connect: EditTextWorkerConnect = connectEditTextWorker,
): EditTextChannel {
	const channel = name === "" ? "interactive" : name === ".background" ? "background" : "test";
	const failed = () =>
		new OutlineEditTextError("OUTLINE_TEXT_FAILED", "Outline text worker failed", 500);
	const state = hotSafe<ChannelState>(`narrafork.outline.editTextWorker${name}`, () => ({
		pool: createPool(),
		budgets: new Map(),
		permanent: false,
	}));

	function checkOwner(): void {
		if (!state.pool || !state.budgets)
			throw new OutlineEditTextError(
				"OUTLINE_TEXT_FAILED",
				"Legacy outline text worker ownership requires a server restart",
				503,
			);
		if (state.permanent) throw abortError();
	}
	function createPool(): WorkerPool<WorkerJob, unknown> {
		return new WorkerPool<WorkerJob, unknown>({
			concurrency: 1,
			maxQueued: limits.maxQueued,
			maxQueuedBytes: limits.maxQueued * (limits.maxBytes + 256),
			idleTimeoutMs: limits.idleMs,
			async create(context) {
				const budget = state.budgets.get(context.requestId)?.timeoutMs ?? limits.timeoutMs;
				const firstDeadline = Date.now() + budget;
				let connected: Awaited<ReturnType<EditTextWorkerConnect>> | undefined;
				try {
					connected = await connect({
						signal: context.signal,
						deadlineAt: Math.min(firstDeadline, Date.now() + limits.startMs),
					});
					context.signal.throwIfAborted();
					if (Date.now() >= firstDeadline) throw timeoutError(budget);
					connected.worker.unref();
				} catch (error) {
					if (error instanceof WorkerCleanupError) throw error;
					if (connected) {
						try {
							await connected.handle.close();
						} catch (cleanup) {
							throw new WorkerCleanupError(connected.handle, cleanup);
						}
					}
					if (context.signal.aborted) throw context.signal.reason;
					if (error instanceof OutlineEditTextError) throw error;
					const cause = error instanceof Error ? error.cause : undefined;
					if (
						(error instanceof WorkerStartupError && error.code === "TIMEOUT") ||
						(cause instanceof WorkerStartupError && cause.code === "TIMEOUT")
					)
						throw timeoutError(Math.min(budget, limits.startMs));
					throw Date.now() >= firstDeadline ? timeoutError(budget) : failed();
				}
				const { worker, handle } = connected;
				let sequence = 0;
				let first = true;
				let invalid = false;
				return {
					get closed() {
						return invalid || handle.closed;
					},
					close: () => handle.close(),
					run({ job, timeoutMs }, task) {
						const deadline =
							first && task.requestId === context.requestId
								? firstDeadline
								: Date.now() + timeoutMs;
						first = false;
						const id = ++sequence;
						return new Promise((resolve, reject) => {
							let done = false;
							let timer: ReturnType<typeof setTimeout> | undefined;
							const finish = (error?: unknown, result?: unknown, retire = false) => {
								if (done) return;
								done = true;
								clearTimeout(timer);
								worker.off("message", receive);
								worker.off("error", died);
								worker.off("messageerror", died);
								worker.off("exit", died);
								task.signal.removeEventListener("abort", abort);
								worker.unref();
								invalid ||= retire;
								if (error !== undefined) reject(error);
								else resolve(result);
							};
							const died = () => finish(failed(), undefined, true);
							const abort = () => finish(abortError(), undefined, true);
							const expired = () => finish(timeoutError(timeoutMs), undefined, true);
							const receive = (value: unknown) => {
								if (!value || typeof value !== "object" || Array.isArray(value)) return died();
								const reply = value as Record<string, unknown>;
								if (reply.ready === true && Object.keys(reply).length === 1) return;
								if (!Number.isSafeInteger(reply.id)) return died();
								if (reply.id !== id) return;
								if (Date.now() >= deadline) return expired();
								if (typeof reply.error === "string" && !Object.hasOwn(reply, "result")) {
									finish(
										new OutlineEditTextError(
											"OUTLINE_TEXT_FAILED",
											reply.error.slice(0, 2048),
											500,
										),
									);
								} else if (
									!Object.hasOwn(reply, "error") &&
									Object.hasOwn(reply, "result") &&
									validResult(job, reply.result)
								)
									finish(undefined, reply.result);
								else died();
							};
							worker.ref();
							worker.on("message", receive);
							worker.on("error", died);
							worker.on("messageerror", died);
							worker.on("exit", died);
							task.signal.addEventListener("abort", abort, { once: true });
							if (task.signal.aborted) return abort();
							if (Date.now() >= deadline) return expired();
							timer = setTimeout(expired, deadline - Date.now());
							try {
								worker.postMessage({ action: "run", id, job } satisfies EditTextWorkerRequest);
							} catch {
								died();
							}
						});
					},
				} satisfies PoolWorker<WorkerJob, unknown>;
			},
			onTaskComplete(timing) {
				if (timing.outcome === "error" || timing.totalMs >= 1000) {
					try {
						logger.warn("Outline text worker task finished", {
							channel,
							...timing,
							bytes: state.budgets.get(timing.requestId)?.bytes ?? 0,
						});
					} catch {
						/* diagnostics cannot change results or cleanup */
					}
				}
			},
		});
	}
	async function run<J extends EditTextJob>(
		job: J,
		options: EditTextRunOptions = {},
	): Promise<EditTextResult<J>> {
		checkOwner();
		if (state.closing) {
			const previous = state.pool;
			await state.closing;
			checkOwner();
			if (state.pool === previous) {
				state.pool = createPool();
				state.closing = undefined;
			}
		}
		const bytes = editTextJobBytes(job);
		if (bytes > limits.maxBytes)
			throw new OutlineEditTextError(
				"OUTLINE_TEXT_TOO_LARGE",
				OUTLINE_TOOL_TEXT.textTooLarge(bytes, limits.maxBytes),
				413,
			);
		options.signal?.throwIfAborted();
		if (options.worker === false || (options.worker === undefined && bytes <= limits.inlineBytes))
			return runEditTextJob(job);
		const timeoutMs = options.timeoutMs ?? limits.timeoutMs;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
			throw new RangeError("timeoutMs must be positive and finite");
		const requestId = generateId();
		state.budgets.set(requestId, { timeoutMs, bytes });
		try {
			return (await state.pool.run(
				{ job, timeoutMs },
				{
					requestId,
					signal: options.signal,
					bytes: bytes + 256,
					deadlineAt: Infinity,
				},
			)) as EditTextResult<J>;
		} catch (error) {
			if (error instanceof OutlineEditTextError) throw error;
			if (options.signal?.aborted) throw abortError();
			if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
				throw new OutlineEditTextError("OUTLINE_TEXT_BUSY", OUTLINE_TOOL_TEXT.textBusy, 503);
			if (error instanceof WorkerPoolError && error.code === "WORKER_POOL_CLOSED")
				throw abortError();
			throw failed();
		} finally {
			state.budgets.delete(requestId);
		}
	}
	return {
		run,
		stop(options = {}) {
			if (!state.pool || !state.budgets)
				return Promise.reject(
					new OutlineEditTextError(
						"OUTLINE_TEXT_FAILED",
						"Legacy outline text worker ownership requires a server restart",
						503,
					),
				);
			state.permanent ||= options.permanent === true;
			state.closing ??= state.pool.close(abortError());
			// Old cleanup callers may intentionally ignore stop; rejection still stays latched.
			void state.closing.catch(() => {});
			return state.closing;
		},
		async resetForTests() {
			await this.stop();
			state.permanent = false;
		},
	};
}

function validResult(job: EditTextJob, result: unknown): boolean {
	if (job.kind === "notes" || job.kind === "report") {
		if (!result || typeof result !== "object" || Array.isArray(result)) return false;
		const value = result as Record<string, unknown>;
		return (
			Array.isArray(value.blocks) &&
			Number.isSafeInteger(value.count) &&
			(value.count as number) >= 0 &&
			Number.isSafeInteger(value.bytes) &&
			(value.bytes as number) >= 0 &&
			(job.kind !== "report" ||
				(Number.isSafeInteger(value.omittedBytes) && (value.omittedBytes as number) >= 0))
		);
	}
	const length =
		job.kind === "parse"
			? job.inputs.length
			: job.kind === "merge"
				? job.merges.length
				: job.contents.length;
	return Array.isArray(result) && result.length === length;
}

// The interactive channel keeps the state key it always had (hot reload finds its worker).
const interactive = createChannel("", OUTLINE_EDIT_TEXT_LIMITS);
const background = createChannel(".background", OUTLINE_BACKGROUND_TEXT_LIMITS);

/**
 * Run a job inline or on the worker (see the module header). Rejects with
 * {@link OutlineEditTextError} when the text is too large, the worker is busy, the job times out
 * or fails.
 */
export async function processEditText<J extends EditTextJob>(
	job: J,
	options: EditTextRunOptions = {},
): Promise<EditTextResult<J>> {
	return await interactive.run(job, options);
}

/**
 * Run a job on the background channel ({@link OUTLINE_BACKGROUND_TEXT_LIMITS}): batch work that
 * must not wait on, or hold up, the interactive worker. Rejects as {@link processEditText} does;
 * a failure is the caller's to retry later, never to run on its own thread.
 */
export async function processBackgroundText<J extends EditTextJob>(
	job: J,
	options: EditTextRunOptions = {},
): Promise<EditTextResult<J>> {
	return await background.run(job, options);
}

/** Stop both channels without dispatching queued work; tests may explicitly use them again. */
export function stopEditTextWorker(): Promise<void> {
	const closing = Promise.all([interactive.stop(), background.stop()]).then(() => {});
	void closing.catch(() => {});
	return closing;
}

/** Production shutdown: permanently reject both worker and ordinary small-text paths. */
export function closeEditTextWorkers(): Promise<void> {
	return Promise.all([
		interactive.stop({ permanent: true }),
		background.stop({ permanent: true }),
	]).then(() => {});
}

export async function resetEditTextWorkersForTests(): Promise<void> {
	await Promise.all([interactive.resetForTests(), background.resetForTests()]);
}
