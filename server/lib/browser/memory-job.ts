import { MEMORY_CLEANUP_TIMEOUT_MS } from "./memory-constants";
import type { BrowserSession } from "./session";

/** Process-local only: never serialized into session stats or restart handoff. */
export interface BrowserMemoryJob {
	controller: AbortController;
	done: Promise<void>;
}

/** Cancel before closing/preserving a context. Never hold shutdown hostage. */
export async function cancelMemoryJob(session: BrowserSession): Promise<void> {
	session.memoryDiagnosticsClosed = true;
	const job = session.memoryJob;
	if (!job) return;
	job.controller.abort(new Error("Browser memory diagnostic cancelled: session closed"));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			job.done,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, MEMORY_CLEANUP_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Bounds waiting on CDP and observes cancellation without dropping late rejection handlers. */
export function waitForMemory<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason ?? new Error("Browser memory diagnostic cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}

export async function runMemoryJob<T>(
	session: BrowserSession,
	timeoutMs: number,
	externalSignal: AbortSignal | undefined,
	run: (signal: AbortSignal, remainingMs: () => number) => Promise<T>,
): Promise<T> {
	if (session.memoryDiagnosticsClosed) throw new Error("Browser session is closing");
	if (session.memoryJob) throw new Error("A memory diagnostic is already active on this session");
	externalSignal?.throwIfAborted();
	const controller = new AbortController();
	let complete!: () => void;
	const job: BrowserMemoryJob = {
		controller,
		done: new Promise<void>((resolve) => {
			complete = resolve;
		}),
	};
	session.memoryJob = job;
	const deadline = Date.now() + timeoutMs;
	const timer = setTimeout(
		() => controller.abort(new Error("Browser memory diagnostic timed out")),
		timeoutMs,
	);
	const abort = () => controller.abort(new Error("Browser memory diagnostic cancelled"));
	externalSignal?.addEventListener("abort", abort, { once: true });
	if (externalSignal?.aborted) abort();
	try {
		return await run(controller.signal, () => Math.max(1, deadline - Date.now()));
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", abort);
		if (session.memoryJob === job) session.memoryJob = undefined;
		complete();
	}
}
