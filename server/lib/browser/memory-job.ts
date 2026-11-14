import { TaskQueue } from "../worker-runtime/queue";
import { MEMORY_CLEANUP_TIMEOUT_MS } from "./memory-constants";
import type { BrowserSession } from "./session";

/** Process-local only: never serialized into session stats or restart handoff. */
export interface BrowserMemoryJob {
	controller: AbortController;
	done: Promise<void>;
	/** Physical cleanup outlives a bounded RPC response. Never serialized. */
	resources?: Set<Promise<unknown>>;
}

interface DiagnosticOwner {
	version: 1;
	ownership: "native-exit";
	queue: TaskQueue;
	jobs: Set<BrowserMemoryJob>;
	closing?: Promise<void>;
}
const OWNER = Symbol.for("narrafork.browser.memory-workers");
const globals = globalThis as typeof globalThis & { [OWNER]?: DiagnosticOwner };
const previous = globals[OWNER];
if (
	previous &&
	(previous.version !== 1 ||
		previous.ownership !== "native-exit" ||
		!previous.queue ||
		!(previous.jobs instanceof Set))
)
	throw new Error("Browser memory worker ownership cannot be recovered");
const owner: DiagnosticOwner = previous ?? {
	version: 1,
	ownership: "native-exit",
	queue: new TaskQueue({ concurrency: 1, maxQueued: 0, maxQueuedBytes: 0 }),
	jobs: new Set(),
};
globals[OWNER] = owner;

/** Admission is shared; payloads and analysis state remain strictly per diagnostic. */
export const memoryDiagnosticQueue = owner.queue;

export function trackMemoryDiagnostic(job: BrowserMemoryJob): void {
	if (owner.closing || owner.queue.stats.closed)
		throw new Error("Browser memory diagnostics are closing");
	owner.jobs.add(job);
	void job.done.then(
		() => owner.jobs.delete(job),
		() => owner.jobs.delete(job),
	);
}

/** Terminal production close: reject new work first, then wait for real resource cleanup. */
export function closeMemoryDiagnosticWorkers(): Promise<void> {
	if (owner.closing) return owner.closing;
	const drained = owner.queue.close();
	for (const job of owner.jobs) job.controller.abort();
	owner.closing = Promise.all([drained, ...[...owner.jobs].map((job) => job.done)]).then(() => {});
	return owner.closing;
}

export function retainMemoryJob(session: BrowserSession, cleanup: Promise<unknown>): void {
	const job = session.memoryJob;
	if (!job) throw new Error("Browser memory diagnostic has no session owner");
	job.resources ??= new Set();
	job.resources.add(cleanup);
}

/** Cancellation responses are bounded; shutdown may explicitly await actual session cleanup. */
export async function cancelMemoryJob(
	session: BrowserSession,
	options: { waitForCleanup?: boolean } = {},
): Promise<void> {
	session.memoryDiagnosticsClosed = true;
	const job = session.memoryJob;
	if (!job) return;
	job.controller.abort(new Error("Browser memory diagnostic cancelled: session closed"));
	if (options.waitForCleanup) return job.done;
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
		// The caller may already have a timeout response while a native worker is still exiting.
		// Keep the session owner until every retained cleanup really settles.
		void Promise.allSettled([...(job.resources ?? [])]).then(() => {
			if (session.memoryJob === job) session.memoryJob = undefined;
			complete();
		});
	}
}
