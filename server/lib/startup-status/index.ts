/**
 * Startup status page, startup-thread side.
 *
 * Before `./main` loads, a worker thread listens on the configured port and shows what startup is
 * doing — chiefly a long database upgrade, which runs synchronously on this thread. `./main`
 * closes it right before binding the port itself. When startup fails, the same page shows why,
 * and the process waits briefly for an open page to read it before exiting.
 *
 * Best effort throughout: when the worker cannot listen there is simply no page, and the real
 * server reports the port problem as it always has.
 */

import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { WorkerCleanupError, type WorkerHandle } from "../worker-runtime/lifecycle";
import type {
	FromStatusWorker,
	StartupProblem,
	StartupSnapshot,
	StartupStep,
	StatusListenTarget,
	ToStatusWorker,
} from "./protocol";

/** How long a failed startup waits at most for a page to read why. */
const PROBLEM_LINGER_MS = 30_000;
/** Binding answers at once; a worker that never answers must not hold up startup. */
const LISTEN_REPLY_MS = 5_000;

interface Starting {
	controller: AbortController;
	promise: Promise<boolean>;
}

const state = hotSafe<{
	handle?: WorkerHandle<Worker>;
	snapshot?: StartupSnapshot;
	starting?: Starting;
	closing?: Promise<void>;
}>("narrafork.startupStatus.v1", () => ({}));

/** One bounded protocol wait; every settlement removes all listeners and its timer. */
function next(
	handle: WorkerHandle<Worker>,
	accept: (message: FromStatusWorker) => boolean,
	deadlineAt: number,
	send: () => void,
	signal?: AbortSignal,
): Promise<FromStatusWorker> {
	const worker = handle.resource;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown, message?: FromStatusWorker) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
			signal?.removeEventListener("abort", onAbort);
			if (message) resolve(message);
			else reject(error);
		};
		const onMessage = (message: FromStatusWorker) => {
			if (!message || !accept(message)) return;
			if (Date.now() >= deadlineAt) finish(new Error("no reply"));
			else finish(undefined, message);
		};
		const onError = (error: Error) => finish(error);
		const onExit = () => finish(new Error("startup status worker exited"));
		const onAbort = () => finish(signal?.reason);
		const timer = setTimeout(
			() => finish(new Error("no reply")),
			Math.max(0, deadlineAt - Date.now()),
		);
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) return onAbort();
		if (handle.closed) return onExit();
		if (Date.now() >= deadlineAt) return finish(new Error("no reply"));
		try {
			send();
		} catch (error) {
			finish(error);
		}
	});
}

/** Listen on `target` and answer with the status page. Resolves to whether it is listening. */
export function startStartupStatus(
	target: StatusListenTarget,
	{ version, brandName }: { version: string; brandName: string },
): Promise<boolean> {
	// A start racing shutdown must not recreate a listener after the port handoff.
	if (state.closing) return Promise.resolve(false);
	if (state.starting) return state.starting.promise;
	if (state.handle) return Promise.resolve(!state.handle.closed && !!state.snapshot);
	const deadlineAt = Date.now() + LISTEN_REPLY_MS;
	const initial: StartupSnapshot = {
		version,
		step: { key: "starting" },
		stepStartedAt: Date.now(),
	};
	const controller = new AbortController();
	// Reserve ownership before connecting (including synchronous creation failure).
	const starting: Starting = {
		controller,
		promise: Promise.resolve().then(async () => {
			let handle: WorkerHandle<Worker> | undefined;
			try {
				({ handle } = await connectCompiledWorker(
					compiledWorkerSpecifiers("lib/startup-status/worker.ts", "./worker.ts", import.meta.url),
					{ deadlineAt, signal: controller.signal },
				));
				state.handle = handle;
				const current = handle;
				void current.exited.then((code) => {
					if (state.handle !== current) return;
					if (state.snapshot && !state.closing) {
						try {
							logger.warn("Startup status page stopped; continuing without it", {
								phase: "exit",
								outcome: "unavailable",
								code,
							});
						} catch {
							// Diagnostics cannot retain an exited owner or reject its observer.
						}
					}
					state.handle = undefined;
					state.snapshot = undefined;
				});
				const result = await next(
					handle,
					(message) => message.type === "listening" || message.type === "unavailable",
					deadlineAt,
					() =>
						current.resource.postMessage({
							type: "listen",
							target,
							snapshot: initial,
							brandName,
						} satisfies ToStatusWorker),
					controller.signal,
				);
				if (result.type === "unavailable") throw new Error(result.error);
				controller.signal.throwIfAborted();
				if (state.closing || current.closed)
					throw new Error("startup status closed while starting");
				// The page is a convenience; it must never keep a finished process alive.
				current.resource.unref();
				state.snapshot = initial;
				return true;
			} catch (error) {
				// No main-thread substitute: the real server reports its own port problem.
				try {
					logger.info("Startup status page unavailable; continuing without it", {
						phase: handle ? "listen" : "ready",
						outcome:
							error instanceof WorkerCleanupError
								? "unclean"
								: controller.signal.aborted
									? "cancelled"
									: "unavailable",
					});
				} catch {
					// The sink must not skip actual retirement or mask the startup result.
				}
				if (error instanceof WorkerCleanupError) {
					const retiring = error.handle as WorkerHandle<Worker>;
					state.handle = retiring;
					void retiring.exited
						.then(() => {
							if (state.handle !== retiring) return;
							state.handle = undefined;
							state.snapshot = undefined;
							state.closing = undefined;
						})
						.catch(() => {});
					return false;
				}
				await handle?.close();
				if (state.handle === handle) state.handle = undefined;
				return false;
			} finally {
				if (state.starting === starting) state.starting = undefined;
			}
		}),
	};
	state.starting = starting;
	return starting.promise;
}

/**
 * A browser is being opened on the page. A failure is then worth waiting for, so the person who
 * started NarraFork sees why; on a headless server nobody would, and exiting at once is better.
 */
export function expectStartupViewer(): void {
	const { handle, closing } = state;
	if (handle && !handle.closed && !closing)
		handle.resource.postMessage({ type: "expect-viewer" } satisfies ToStatusWorker);
}

function update(next: StartupSnapshot): void {
	state.snapshot = next;
	state.handle?.resource.postMessage({ type: "update", snapshot: next } satisfies ToStatusWorker);
}

export function reportStartupStep(step: StartupStep): void {
	if (state.handle && !state.handle.closed && state.snapshot)
		update({ ...state.snapshot, step, stepStartedAt: Date.now() });
}

/** Free the port for the real server. Terminating the thread closes its listener. */
export function closeStartupStatus(): Promise<void> {
	if (state.closing) return state.closing;
	const starting = state.starting;
	starting?.controller.abort(new Error("startup status closing"));
	state.snapshot = undefined;
	const closing = Promise.resolve().then(async () => {
		// connect owns its pending candidate; abort makes it confirm exit before returning.
		await starting?.promise;
		const handle = state.handle;
		await handle?.close();
		if (state.handle === handle) state.handle = undefined;
		if (state.closing === closing) state.closing = undefined;
	});
	state.closing = closing;
	return closing;
}

/**
 * Show why startup failed and, when a page is open or being opened, give it the chance to read
 * that before the process exits. Returns at once when there is no status page.
 */
export async function showStartupProblem(problem: StartupProblem): Promise<void> {
	const { handle, snapshot } = state;
	if (!handle || handle.closed || !snapshot || state.closing) return;
	try {
		await next(
			handle,
			(message) => message.type === "problem-shown",
			Date.now() + PROBLEM_LINGER_MS,
			() => update({ ...snapshot, problem }),
		);
	} catch {
		// A lost page or an expired linger budget must not hide the real startup error.
	}
}
