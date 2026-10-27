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
import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "@server/lib/compiled-worker";
import { AppError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
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

interface Task {
	id: number;
	job: EditTextJob;
	timeoutMs: number;
	signal?: AbortSignal;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
}

const state = hotSafe("narrafork.outline.editTextWorker", () => ({
	worker: null as Worker | null,
	starting: null as Promise<Worker> | null,
	queue: [] as Task[],
	active: null as Task | null,
	idle: null as ReturnType<typeof setTimeout> | null,
	nextId: 0,
}));

function timeoutError(ms: number): OutlineEditTextError {
	return new OutlineEditTextError("OUTLINE_TEXT_TIMEOUT", OUTLINE_TOOL_TEXT.textTimeout(ms), 504);
}

function abortError(): OutlineEditTextError {
	return new OutlineEditTextError("OUTLINE_TEXT_FAILED", OUTLINE_TOOL_TEXT.textCancelled, 499);
}

function stopWorker(): void {
	const worker = state.worker;
	state.worker = null;
	state.starting = null;
	if (worker) void worker.terminate();
}

function settle(task: Task, error: Error | null, value?: unknown): void {
	if (task.timer) clearTimeout(task.timer);
	if (task.onAbort) task.signal?.removeEventListener("abort", task.onAbort);
	if (state.active === task) state.active = null;
	if (error) task.reject(error);
	else task.resolve(value);
	pump();
}

function onMessage(message: { id?: number; result?: unknown; error?: string }): void {
	const task = state.active;
	if (!task || message.id !== task.id) return;
	if (typeof message.error === "string") {
		settle(task, new OutlineEditTextError("OUTLINE_TEXT_FAILED", message.error, 500));
	} else settle(task, null, message.result);
}

function onDeath(worker: Worker, error: Error): void {
	if (state.worker !== worker) return;
	state.worker = null;
	state.starting = null;
	const task = state.active;
	if (task) settle(task, new OutlineEditTextError("OUTLINE_TEXT_FAILED", error.message, 500));
}

async function ensureWorker(): Promise<Worker> {
	if (state.worker) return state.worker;
	if (!state.starting) {
		const starting = connectCompiledWorker(
			compiledWorkerSpecifiers(
				"services/outline/edit-text-worker.ts",
				"./edit-text-worker.ts",
				import.meta.url,
			),
			{ signal: AbortSignal.timeout(OUTLINE_EDIT_TEXT_LIMITS.startMs) },
		).then(({ worker }) => {
			if (state.starting !== starting) {
				void worker.terminate();
				throw new Error("outline text worker was replaced while starting");
			}
			state.worker = worker;
			state.starting = null;
			worker.unref();
			worker.on("message", onMessage);
			worker.on("error", (error: unknown) =>
				onDeath(worker, error instanceof Error ? error : new Error(String(error))),
			);
			worker.on("exit", (code) => onDeath(worker, new Error(`worker exited (${code})`)));
			return worker;
		});
		starting.catch(() => {
			if (state.starting === starting) state.starting = null;
		});
		state.starting = starting;
	}
	return await state.starting;
}

function pump(): void {
	if (state.active) return;
	const task = state.queue.shift();
	if (!task) {
		if (state.worker && !state.idle) {
			state.idle = setTimeout(() => {
				state.idle = null;
				if (!state.active && state.queue.length === 0) stopWorker();
			}, OUTLINE_EDIT_TEXT_LIMITS.idleMs);
			state.idle.unref?.();
		}
		return;
	}
	if (state.idle) {
		clearTimeout(state.idle);
		state.idle = null;
	}
	if (task.signal?.aborted) {
		task.reject(abortError());
		pump();
		return;
	}
	state.active = task;
	const started = performance.now();
	// The job runs synchronously on the worker: giving up on it means ending the thread.
	const abandon = (error: Error) => {
		if (state.active !== task) return;
		stopWorker();
		settle(task, error);
	};
	task.timer = setTimeout(() => {
		logger.warn("Outline edit text job timed out", {
			bytes: editTextJobBytes(task.job),
			elapsedMs: Math.round(performance.now() - started),
		});
		abandon(timeoutError(task.timeoutMs));
	}, task.timeoutMs);
	if (task.signal) {
		task.onAbort = () => abandon(abortError());
		task.signal.addEventListener("abort", task.onAbort, { once: true });
	}
	ensureWorker().then(
		(worker) => {
			if (state.active !== task) return;
			const request: EditTextWorkerRequest = { action: "run", id: task.id, job: task.job };
			worker.postMessage(request);
		},
		(error: unknown) => {
			if (state.active !== task) return;
			settle(
				task,
				new OutlineEditTextError(
					"OUTLINE_TEXT_FAILED",
					error instanceof Error ? error.message : String(error),
					500,
				),
			);
		},
	);
}

/**
 * Run a job inline or on the worker (see the module header). Rejects with
 * {@link OutlineEditTextError} when the text is too large, the worker is busy, the job times out
 * or fails.
 */
export async function processEditText<J extends EditTextJob>(
	job: J,
	options: EditTextRunOptions = {},
): Promise<EditTextResult<J>> {
	const bytes = editTextJobBytes(job);
	if (bytes > OUTLINE_EDIT_TEXT_LIMITS.maxBytes) {
		throw new OutlineEditTextError(
			"OUTLINE_TEXT_TOO_LARGE",
			OUTLINE_TOOL_TEXT.textTooLarge(bytes, OUTLINE_EDIT_TEXT_LIMITS.maxBytes),
			413,
		);
	}
	options.signal?.throwIfAborted();
	if (
		options.worker === false ||
		(options.worker === undefined && bytes <= OUTLINE_EDIT_TEXT_LIMITS.inlineBytes)
	) {
		return runEditTextJob(job);
	}
	if (state.queue.length >= OUTLINE_EDIT_TEXT_LIMITS.maxQueued) {
		throw new OutlineEditTextError("OUTLINE_TEXT_BUSY", OUTLINE_TOOL_TEXT.textBusy, 503);
	}
	return await new Promise<EditTextResult<J>>((resolve, reject) => {
		state.queue.push({
			id: ++state.nextId,
			job,
			timeoutMs: options.timeoutMs ?? OUTLINE_EDIT_TEXT_LIMITS.timeoutMs,
			signal: options.signal,
			resolve: resolve as (value: unknown) => void,
			reject,
		});
		pump();
	});
}

/** Stop the worker now (tests, shutdown). Jobs in flight fail. */
export function stopEditTextWorker(): void {
	const task = state.active;
	stopWorker();
	if (task) settle(task, abortError());
}
